/*
 * GeneratePreviewForURL.m — Quick Look HTML preview para .md
 * ============================================================================
 * Lê arquivo Markdown em UTF-8, parseia YAML frontmatter, converte body em
 * HTML (subset suficiente: headings H1-H6, **bold**, *italic*, `code`, links,
 * [[wikilinks]], lists, blockquotes, code blocks ```lang).
 *
 * O HTML carrega CSS embutido com tokens Anthropic (Orange #d97757, Lora
 * serif body, Poppins-fallback headings, mono SF Mono). Tema light por
 * default — Quick Look não expõe trait de dark mode confiável em todas
 * versões de macOS.
 *
 * Renderização rápida (sem fork de processo, sem parser pesado). Alvo:
 * preview <50ms em arquivo típico de 5-50KB. Para arquivos >256KB o body é
 * truncado com aviso visível ("...preview limitado a 256KB").
 * ============================================================================
 */

#import <Foundation/Foundation.h>
#import <QuickLook/QuickLook.h>

OSStatus GeneratePreviewForURL(void *thisInterface,
                               QLPreviewRequestRef preview,
                               CFURLRef url,
                               CFStringRef contentTypeUTI,
                               CFDictionaryRef options);
void CancelPreviewGeneration(void *thisInterface,
                             QLPreviewRequestRef preview);

#pragma mark - Helpers

static NSString *zeusEscapeHTML(NSString *raw) {
    if (raw == nil) {
        return @"";
    }
    NSMutableString *out = [NSMutableString stringWithCapacity:raw.length];
    NSUInteger len = raw.length;
    for (NSUInteger i = 0; i < len; i++) {
        unichar c = [raw characterAtIndex:i];
        switch (c) {
            case '&':  [out appendString:@"&amp;"]; break;
            case '<':  [out appendString:@"&lt;"];  break;
            case '>':  [out appendString:@"&gt;"];  break;
            case '"':  [out appendString:@"&quot;"];break;
            case '\'': [out appendString:@"&#39;"]; break;
            default:   [out appendFormat:@"%C", c]; break;
        }
    }
    return out;
}

/* Split frontmatter YAML do body. Suporta delimitador --- no início + segundo --- como close. */
static void zeusSplitFrontmatter(NSString *full, NSString **outYaml, NSString **outBody) {
    *outYaml = nil;
    *outBody = full ?: @"";

    if (![full hasPrefix:@"---\n"] && ![full hasPrefix:@"---\r\n"]) {
        return;
    }
    NSUInteger startScan = [full hasPrefix:@"---\r\n"] ? 5 : 4;
    NSRange searchRange = NSMakeRange(startScan, full.length - startScan);

    NSRange closeUnix = [full rangeOfString:@"\n---\n" options:0 range:searchRange];
    NSRange closeCRLF = [full rangeOfString:@"\r\n---\r\n" options:0 range:searchRange];
    NSRange close = NSMakeRange(NSNotFound, 0);
    NSUInteger closeSkip = 0;

    if (closeUnix.location != NSNotFound && (closeCRLF.location == NSNotFound || closeUnix.location < closeCRLF.location)) {
        close = closeUnix;
        closeSkip = 5;
    } else if (closeCRLF.location != NSNotFound) {
        close = closeCRLF;
        closeSkip = 7;
    }

    if (close.location == NSNotFound) {
        return;
    }
    *outYaml = [full substringWithRange:NSMakeRange(startScan, close.location - startScan)];
    NSUInteger bodyStart = close.location + closeSkip;
    if (bodyStart < full.length) {
        *outBody = [full substringFromIndex:bodyStart];
    } else {
        *outBody = @"";
    }
}

/* Parser YAML mínimo: chave: valor (escalar) e chave: [a, b, c] (lista inline).
 * Não tenta lidar com mapas aninhados ou listas multilinha — Quick Look não
 * precisa de fidelidade YAML completa, só da intenção do autor. */
static NSDictionary *zeusParseFrontmatter(NSString *yaml) {
    if (yaml.length == 0) {
        return @{};
    }
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    NSArray<NSString *> *lines = [yaml componentsSeparatedByString:@"\n"];
    for (NSString *line in lines) {
        NSString *trimmed = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (trimmed.length == 0 || [trimmed hasPrefix:@"#"]) {
            continue;
        }
        NSRange colon = [trimmed rangeOfString:@":"];
        if (colon.location == NSNotFound) {
            continue;
        }
        NSString *key = [[trimmed substringToIndex:colon.location] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString *value = [[trimmed substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (key.length == 0) {
            continue;
        }
        if ([value hasPrefix:@"["] && [value hasSuffix:@"]"]) {
            NSString *inner = [value substringWithRange:NSMakeRange(1, value.length - 2)];
            NSArray<NSString *> *parts = [inner componentsSeparatedByString:@","];
            NSMutableArray *items = [NSMutableArray array];
            for (NSString *p in parts) {
                NSString *clean = [[p stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\"'"]];
                if (clean.length > 0) {
                    [items addObject:clean];
                }
            }
            dict[key] = items;
        } else {
            NSString *clean = [value stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"\"'"]];
            dict[key] = clean;
        }
    }
    return dict;
}

/* Inline transforms — código primeiro (preserva $1 textual), depois bold/italic/wikilinks/links. */
static NSString *zeusApplyInline(NSString *escaped) {
    NSString *s = escaped;

    /* `code` — backticks. */
    NSRegularExpression *codeRx = [NSRegularExpression regularExpressionWithPattern:@"`([^`]+)`" options:0 error:nil];
    s = [codeRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<code class=\"zeus-inline-code\">$1</code>"];

    /* **bold** — antes de italic pra não comer asterisco duplo. */
    NSRegularExpression *boldRx = [NSRegularExpression regularExpressionWithPattern:@"\\*\\*([^*]+)\\*\\*" options:0 error:nil];
    s = [boldRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<strong>$1</strong>"];

    /* *italic* — single asterisco. */
    NSRegularExpression *italicRx = [NSRegularExpression regularExpressionWithPattern:@"(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)" options:0 error:nil];
    s = [italicRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<em>$1</em>"];

    /* [[wikilinks|alias]] — alias opcional. */
    NSRegularExpression *wikiAliasRx = [NSRegularExpression regularExpressionWithPattern:@"\\[\\[([^\\]\\|]+)\\|([^\\]]+)\\]\\]" options:0 error:nil];
    s = [wikiAliasRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<a class=\"zeus-wikilink\" href=\"obsidian://open?file=$1\">$2</a>"];

    /* [[wikilinks]] sem alias. */
    NSRegularExpression *wikiRx = [NSRegularExpression regularExpressionWithPattern:@"\\[\\[([^\\]]+)\\]\\]" options:0 error:nil];
    s = [wikiRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<a class=\"zeus-wikilink\" href=\"obsidian://open?file=$1\">$1</a>"];

    /* [text](url) — links markdown. */
    NSRegularExpression *linkRx = [NSRegularExpression regularExpressionWithPattern:@"\\[([^\\]]+)\\]\\(([^)]+)\\)" options:0 error:nil];
    s = [linkRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"<a class=\"zeus-link\" href=\"$2\">$1</a>"];

    return s;
}

/* Markdown body → HTML.
 * Linhas processadas sequencialmente: code blocks ```...``` capturados como bloco,
 * resto vai por linha pra detectar heading/list/blockquote/parágrafo. */
static NSString *zeusRenderBody(NSString *body) {
    if (body.length == 0) {
        return @"";
    }
    NSArray<NSString *> *lines = [body componentsSeparatedByString:@"\n"];
    NSMutableString *out = [NSMutableString stringWithCapacity:body.length * 2];

    BOOL inCodeBlock = NO;
    NSString *codeLang = @"";
    NSMutableString *codeBuf = [NSMutableString string];
    BOOL inUL = NO;
    BOOL inOL = NO;

    for (NSString *line in lines) {
        /* Code fence — ```lang ou ``` puro. */
        if ([line hasPrefix:@"```"]) {
            if (inCodeBlock) {
                NSString *escapedCode = zeusEscapeHTML(codeBuf);
                [out appendFormat:@"<pre class=\"zeus-code\"><code class=\"lang-%@\">%@</code></pre>\n",
                 zeusEscapeHTML(codeLang), escapedCode];
                codeBuf = [NSMutableString string];
                codeLang = @"";
                inCodeBlock = NO;
            } else {
                if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
                if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
                codeLang = [line substringFromIndex:3];
                inCodeBlock = YES;
            }
            continue;
        }
        if (inCodeBlock) {
            [codeBuf appendString:line];
            [codeBuf appendString:@"\n"];
            continue;
        }

        NSString *stripped = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];

        /* Linha vazia — encerra listas abertas, gera parágrafo separador. */
        if (stripped.length == 0) {
            if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
            if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
            continue;
        }

        /* Heading H1-H6 */
        NSUInteger hashCount = 0;
        while (hashCount < stripped.length && [stripped characterAtIndex:hashCount] == '#') { hashCount++; }
        if (hashCount > 0 && hashCount <= 6 && hashCount < stripped.length && [stripped characterAtIndex:hashCount] == ' ') {
            if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
            if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
            NSString *content = [stripped substringFromIndex:hashCount + 1];
            NSString *inline = zeusApplyInline(zeusEscapeHTML(content));
            [out appendFormat:@"<h%lu class=\"zeus-h zeus-h%lu\">%@</h%lu>\n",
             (unsigned long)hashCount, (unsigned long)hashCount, inline, (unsigned long)hashCount];
            continue;
        }

        /* Blockquote */
        if ([stripped hasPrefix:@"> "]) {
            if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
            if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
            NSString *content = [stripped substringFromIndex:2];
            NSString *inline = zeusApplyInline(zeusEscapeHTML(content));
            [out appendFormat:@"<blockquote class=\"zeus-quote\">%@</blockquote>\n", inline];
            continue;
        }

        /* Lista não-ordenada */
        if ([stripped hasPrefix:@"- "] || [stripped hasPrefix:@"* "]) {
            if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
            if (!inUL) { [out appendString:@"<ul class=\"zeus-list\">\n"]; inUL = YES; }
            NSString *content = [stripped substringFromIndex:2];
            NSString *inline = zeusApplyInline(zeusEscapeHTML(content));
            [out appendFormat:@"<li>%@</li>\n", inline];
            continue;
        }

        /* Lista ordenada — "1. foo", "2. bar" */
        NSRegularExpression *olRx = [NSRegularExpression regularExpressionWithPattern:@"^\\d+\\.\\s" options:0 error:nil];
        NSTextCheckingResult *olMatch = [olRx firstMatchInString:stripped options:0 range:NSMakeRange(0, stripped.length)];
        if (olMatch && olMatch.range.location == 0) {
            if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
            if (!inOL) { [out appendString:@"<ol class=\"zeus-list zeus-list-ord\">\n"]; inOL = YES; }
            NSString *content = [stripped substringFromIndex:NSMaxRange(olMatch.range)];
            NSString *inline = zeusApplyInline(zeusEscapeHTML(content));
            [out appendFormat:@"<li>%@</li>\n", inline];
            continue;
        }

        /* Parágrafo padrão */
        if (inUL) { [out appendString:@"</ul>\n"]; inUL = NO; }
        if (inOL) { [out appendString:@"</ol>\n"]; inOL = NO; }
        NSString *inline = zeusApplyInline(zeusEscapeHTML(stripped));
        [out appendFormat:@"<p>%@</p>\n", inline];
    }

    if (inUL)        { [out appendString:@"</ul>\n"]; }
    if (inOL)        { [out appendString:@"</ol>\n"]; }
    if (inCodeBlock) {
        /* Code block não fechado — encerra graciosamente. */
        NSString *escapedCode = zeusEscapeHTML(codeBuf);
        [out appendFormat:@"<pre class=\"zeus-code\"><code class=\"lang-%@\">%@</code></pre>\n",
         zeusEscapeHTML(codeLang), escapedCode];
    }
    return out;
}

/* Header frontmatter renderizado como bloco visível com chips. */
static NSString *zeusRenderFrontmatter(NSDictionary *fm) {
    if (fm.count == 0) {
        return @"";
    }
    NSMutableString *out = [NSMutableString stringWithString:@"<header class=\"zeus-fm\">\n"];

    NSArray *ordered = @[@"tipo", @"status", @"criado", @"atualizado", @"privacidade"];
    for (NSString *key in ordered) {
        id val = fm[key];
        if (val == nil) {
            continue;
        }
        if ([val isKindOfClass:[NSString class]]) {
            [out appendFormat:@"<span class=\"zeus-fm-pair\"><span class=\"zeus-fm-key\">%@</span><span class=\"zeus-fm-val\">%@</span></span>\n",
             zeusEscapeHTML(key), zeusEscapeHTML(val)];
        }
    }

    id tags = fm[@"tags"];
    if ([tags isKindOfClass:[NSArray class]] && [(NSArray *)tags count] > 0) {
        [out appendString:@"<div class=\"zeus-fm-tags\">\n"];
        for (NSString *tag in tags) {
            if ([tag isKindOfClass:[NSString class]]) {
                [out appendFormat:@"<span class=\"zeus-chip\">#%@</span>", zeusEscapeHTML(tag)];
            }
        }
        [out appendString:@"</div>\n"];
    }

    /* Outras keys não-padronizadas. */
    for (NSString *key in fm.allKeys) {
        if ([ordered containsObject:key] || [key isEqualToString:@"tags"]) {
            continue;
        }
        id val = fm[key];
        if ([val isKindOfClass:[NSString class]]) {
            [out appendFormat:@"<span class=\"zeus-fm-pair\"><span class=\"zeus-fm-key\">%@</span><span class=\"zeus-fm-val\">%@</span></span>\n",
             zeusEscapeHTML(key), zeusEscapeHTML(val)];
        }
    }

    [out appendString:@"</header>\n"];
    return out;
}

/* CSS embutido — paleta Anthropic (Orange #d97757, Lora body, Poppins headings).
 * Espelha tokens de ../../../styles.css mas standalone — Quick Look não compartilha CSS. */
static NSString *zeusCSS(void) {
    return @"<style>\n"
    @":root { --zeus-orange: #d97757; --zeus-orange-soft: rgba(217,119,87,0.12); "
    @"--zeus-dark: #141413; --zeus-light: #faf9f5; --zeus-midgray: #b0aea5; "
    @"--zeus-lightgray: #e8e6dc; --zeus-border: rgba(20,20,19,0.12); }\n"
    @"* { box-sizing: border-box; }\n"
    @"html, body { margin: 0; padding: 0; }\n"
    @"body { font-family: 'Lora', Georgia, serif; font-size: 14px; line-height: 1.62; "
    @"color: var(--zeus-dark); background: var(--zeus-light); padding: 28px 36px; "
    @"-webkit-font-smoothing: antialiased; }\n"
    @".zeus-fm { background: var(--zeus-orange-soft); border-left: 3px solid var(--zeus-orange); "
    @"padding: 12px 16px; border-radius: 6px; margin-bottom: 24px; display: flex; "
    @"flex-wrap: wrap; gap: 10px 16px; align-items: center; font-family: 'Poppins', -apple-system, sans-serif; "
    @"font-size: 12px; }\n"
    @".zeus-fm-pair { display: inline-flex; gap: 6px; align-items: baseline; }\n"
    @".zeus-fm-key { color: var(--zeus-midgray); font-weight: 600; text-transform: uppercase; "
    @"letter-spacing: 0.04em; font-size: 10px; }\n"
    @".zeus-fm-val { color: var(--zeus-dark); font-weight: 500; }\n"
    @".zeus-fm-tags { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; margin-top: 4px; }\n"
    @".zeus-chip { background: var(--zeus-orange); color: var(--zeus-light); padding: 2px 8px; "
    @"border-radius: 10px; font-size: 11px; font-weight: 600; font-family: ui-monospace, 'SF Mono', monospace; }\n"
    @".zeus-h { font-family: 'Poppins', -apple-system, sans-serif; font-weight: 700; "
    @"color: var(--zeus-dark); margin: 1.6em 0 0.4em; letter-spacing: -0.02em; line-height: 1.2; }\n"
    @".zeus-h1 { font-size: 26px; border-bottom: 2px solid var(--zeus-orange); padding-bottom: 8px; margin-top: 0; }\n"
    @".zeus-h2 { font-size: 21px; }\n"
    @".zeus-h3 { font-size: 17px; }\n"
    @".zeus-h4 { font-size: 15px; color: var(--zeus-midgray); }\n"
    @".zeus-h5, .zeus-h6 { font-size: 13px; color: var(--zeus-midgray); text-transform: uppercase; letter-spacing: 0.06em; }\n"
    @"p { margin: 0.7em 0; }\n"
    @".zeus-list { margin: 0.6em 0; padding-left: 1.6em; }\n"
    @".zeus-list li { margin: 0.18em 0; }\n"
    @".zeus-quote { margin: 1em 0; padding: 8px 16px; border-left: 3px solid var(--zeus-midgray); "
    @"background: rgba(176,174,165,0.1); color: var(--zeus-dark); font-style: italic; border-radius: 0 4px 4px 0; }\n"
    @".zeus-code { background: var(--zeus-dark); color: var(--zeus-light); padding: 14px 18px; "
    @"border-radius: 6px; overflow-x: auto; font-family: ui-monospace, 'SF Mono', Menlo, monospace; "
    @"font-size: 12.5px; line-height: 1.5; margin: 1em 0; }\n"
    @".zeus-code code { background: transparent; padding: 0; color: inherit; font-family: inherit; }\n"
    @".zeus-inline-code { background: var(--zeus-lightgray); padding: 1px 6px; border-radius: 3px; "
    @"font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12.5px; color: var(--zeus-dark); }\n"
    @".zeus-wikilink { color: var(--zeus-orange); text-decoration: none; border-bottom: 1px dashed var(--zeus-orange); }\n"
    @".zeus-wikilink:hover { background: var(--zeus-orange-soft); }\n"
    @".zeus-link { color: var(--zeus-orange); text-decoration: underline; text-decoration-color: rgba(217,119,87,0.4); }\n"
    @".zeus-footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--zeus-border); "
    @"color: var(--zeus-midgray); font-size: 11px; font-family: 'Poppins', -apple-system, sans-serif; "
    @"display: flex; justify-content: space-between; align-items: center; }\n"
    @".zeus-truncated { background: rgba(204,68,85,0.12); color: #c45; padding: 8px 12px; border-radius: 4px; "
    @"font-size: 12px; margin-top: 16px; font-family: 'Poppins', -apple-system, sans-serif; }\n"
    @"</style>\n";
}

#pragma mark - Quick Look entry

OSStatus GeneratePreviewForURL(void *thisInterface,
                               QLPreviewRequestRef preview,
                               CFURLRef url,
                               CFStringRef contentTypeUTI,
                               CFDictionaryRef options) {
    (void)thisInterface;
    (void)contentTypeUTI;
    (void)options;

    @autoreleasepool {
        if (QLPreviewRequestIsCancelled(preview)) {
            return noErr;
        }

        NSURL *nsURL = (__bridge NSURL *)url;
        NSError *readError = nil;
        NSString *fullText = [NSString stringWithContentsOfURL:nsURL encoding:NSUTF8StringEncoding error:&readError];
        if (fullText == nil) {
            /* Fallback — tenta Latin-1 pra arquivo legado mal-codificado. */
            fullText = [NSString stringWithContentsOfURL:nsURL encoding:NSISOLatin1StringEncoding error:nil];
        }
        if (fullText == nil) {
            return noErr;
        }

        BOOL truncated = NO;
        const NSUInteger maxBytes = 256 * 1024;
        if (fullText.length > maxBytes) {
            fullText = [fullText substringToIndex:maxBytes];
            truncated = YES;
        }

        NSString *yaml = nil;
        NSString *body = nil;
        zeusSplitFrontmatter(fullText, &yaml, &body);
        NSDictionary *fm = zeusParseFrontmatter(yaml);

        NSString *fileName = [[nsURL lastPathComponent] stringByDeletingPathExtension];
        NSString *escapedTitle = zeusEscapeHTML(fileName);
        NSString *fmHTML = zeusRenderFrontmatter(fm);
        NSString *bodyHTML = zeusRenderBody(body);

        NSMutableString *html = [NSMutableString stringWithCapacity:bodyHTML.length + 4096];
        [html appendString:@"<!DOCTYPE html><html lang=\"pt-BR\"><head><meta charset=\"UTF-8\">"];
        [html appendFormat:@"<title>%@</title>", escapedTitle];
        [html appendString:zeusCSS()];
        [html appendString:@"</head><body>"];
        [html appendString:fmHTML];
        [html appendString:bodyHTML];
        if (truncated) {
            [html appendString:@"<div class=\"zeus-truncated\">Preview limitado a 256 KB — abra no Obsidian para ver o conteúdo completo.</div>"];
        }
        [html appendString:@"<div class=\"zeus-footer\"><span>Zeus Markdown Quick Look</span>"];
        [html appendFormat:@"<span>%@.md</span></div>", escapedTitle];
        [html appendString:@"</body></html>"];

        if (QLPreviewRequestIsCancelled(preview)) {
            return noErr;
        }

        NSData *data = [html dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *props = @{
            (__bridge NSString *)kQLPreviewPropertyMIMETypeKey: @"text/html",
            (__bridge NSString *)kQLPreviewPropertyTextEncodingNameKey: @"UTF-8",
            (__bridge NSString *)kQLPreviewPropertyDisplayNameKey: fileName ?: @"Markdown"
        };
        QLPreviewRequestSetDataRepresentation(preview,
                                              (__bridge CFDataRef)data,
                                              kUTTypeHTML,
                                              (__bridge CFDictionaryRef)props);
    }
    return noErr;
}

void CancelPreviewGeneration(void *thisInterface, QLPreviewRequestRef preview) {
    (void)thisInterface;
    (void)preview;
    /* Cancelamento cooperativo — checks de QLPreviewRequestIsCancelled em GeneratePreviewForURL. */
}
