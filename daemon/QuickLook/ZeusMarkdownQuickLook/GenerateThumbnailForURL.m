/*
 * GenerateThumbnailForURL.m — Quick Look thumbnail para .md
 * ============================================================================
 * Extrai primeiro H1 + primeiro parágrafo do arquivo e renderiza thumbnail
 * via NSImage/CGContext. Inclui badge "Z" no canto inferior direito (cor
 * Anthropic Orange) para marcar visualmente que veio do Zeus Quick Look.
 *
 * Tamanhos típicos: 16, 32, 64, 128, 256, 512, 1024 (Finder Cover Flow,
 * Quick Look thumbnail, Spotlight result). maxSize indica o pedido — se
 * <=32, renderiza só o badge Z sem texto.
 *
 * Performance: alvo <30ms. Lê só primeiros 32KB do arquivo (suficiente para
 * achar H1 + parágrafo inicial em qualquer documento real).
 * ============================================================================
 */

#import <Cocoa/Cocoa.h>
#import <QuickLook/QuickLook.h>

OSStatus GenerateThumbnailForURL(void *thisInterface,
                                 QLThumbnailRequestRef thumbnail,
                                 CFURLRef url,
                                 CFStringRef contentTypeUTI,
                                 CFDictionaryRef options,
                                 CGSize maxSize);
void CancelThumbnailGeneration(void *thisInterface,
                               QLThumbnailRequestRef thumbnail);

/* Extrai H1 + 1º parágrafo. Pula frontmatter YAML --- ... ---. */
static void zeusExtractHead(NSString *text, NSString **outTitle, NSString **outPara) {
    *outTitle = @"";
    *outPara = @"";

    NSArray<NSString *> *lines = [text componentsSeparatedByString:@"\n"];
    NSUInteger i = 0;
    NSUInteger count = lines.count;

    /* Pula frontmatter. */
    if (count > 0 && [[lines[0] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] isEqualToString:@"---"]) {
        i = 1;
        while (i < count && ![[lines[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] isEqualToString:@"---"]) {
            i++;
        }
        if (i < count) { i++; }
    }

    /* Procura primeiro H1 (# foo). */
    for (; i < count; i++) {
        NSString *line = [lines[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if ([line hasPrefix:@"# "]) {
            *outTitle = [line substringFromIndex:2];
            i++;
            break;
        }
        if (line.length > 0 && ![line hasPrefix:@"#"]) {
            /* Sem H1 — usa primeira linha não-vazia como pseudo-título. */
            *outTitle = line;
            i++;
            break;
        }
    }

    /* Primeiro parágrafo não-vazio após o título. */
    for (; i < count; i++) {
        NSString *line = [lines[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (line.length > 0 && ![line hasPrefix:@"#"] && ![line hasPrefix:@"```"]) {
            *outPara = line;
            break;
        }
    }
}

/* Strip markdown inline simples (asteriscos, backticks, wikilinks) para o
 * thumbnail. Não-destrutivo para o preview principal. */
static NSString *zeusStripInline(NSString *raw) {
    NSMutableString *s = [raw mutableCopy];
    [s replaceOccurrencesOfString:@"**" withString:@"" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:@"`" withString:@"" options:0 range:NSMakeRange(0, s.length)];

    NSRegularExpression *wikiRx = [NSRegularExpression regularExpressionWithPattern:@"\\[\\[([^\\]\\|]+)(?:\\|([^\\]]+))?\\]\\]" options:0 error:nil];
    NSString *out = [wikiRx stringByReplacingMatchesInString:s options:0 range:NSMakeRange(0, s.length) withTemplate:@"$1"];

    NSRegularExpression *linkRx = [NSRegularExpression regularExpressionWithPattern:@"\\[([^\\]]+)\\]\\(([^)]+)\\)" options:0 error:nil];
    out = [linkRx stringByReplacingMatchesInString:out options:0 range:NSMakeRange(0, out.length) withTemplate:@"$1"];

    return out;
}

OSStatus GenerateThumbnailForURL(void *thisInterface,
                                 QLThumbnailRequestRef thumbnail,
                                 CFURLRef url,
                                 CFStringRef contentTypeUTI,
                                 CFDictionaryRef options,
                                 CGSize maxSize) {
    (void)thisInterface;
    (void)contentTypeUTI;
    (void)options;

    @autoreleasepool {
        if (QLThumbnailRequestIsCancelled(thumbnail)) {
            return noErr;
        }

        NSURL *nsURL = (__bridge NSURL *)url;
        NSError *readError = nil;
        NSData *headData = [NSData dataWithContentsOfURL:nsURL options:NSDataReadingMappedIfSafe error:&readError];
        if (headData == nil) {
            return noErr;
        }
        if (headData.length > 32 * 1024) {
            headData = [headData subdataWithRange:NSMakeRange(0, 32 * 1024)];
        }
        NSString *text = [[NSString alloc] initWithData:headData encoding:NSUTF8StringEncoding];
        if (text == nil) {
            text = [[NSString alloc] initWithData:headData encoding:NSISOLatin1StringEncoding];
        }
        if (text == nil) {
            text = @"";
        }

        NSString *title = nil;
        NSString *para = nil;
        zeusExtractHead(text, &title, &para);
        title = zeusStripInline(title);
        para  = zeusStripInline(para);
        if (title.length == 0) {
            title = [[nsURL lastPathComponent] stringByDeletingPathExtension];
        }

        /* Aspect ratio 3:4 — combina com ícones do Finder. */
        CGFloat aspect = 4.0 / 3.0;
        CGFloat width = MAX(64.0, maxSize.width);
        CGFloat height = width * aspect;
        if (height > maxSize.height && maxSize.height > 0) {
            height = maxSize.height;
            width = height / aspect;
        }

        NSSize size = NSMakeSize(width, height);
        NSImage *image = [[NSImage alloc] initWithSize:size];
        [image lockFocus];

        /* Background — papel claro Anthropic. */
        NSColor *paper = [NSColor colorWithCalibratedRed:0.98 green:0.976 blue:0.96 alpha:1.0];
        [paper setFill];
        NSRectFill(NSMakeRect(0, 0, width, height));

        /* Barra superior orange (assinatura Zeus). */
        NSColor *orange = [NSColor colorWithCalibratedRed:0.85 green:0.467 blue:0.341 alpha:1.0];
        [orange setFill];
        NSRectFill(NSMakeRect(0, height - height * 0.04, width, height * 0.04));

        if (width >= 96) {
            CGFloat padding = width * 0.08;
            CGFloat titleSize = MAX(11.0, width * 0.072);
            CGFloat bodySize  = MAX(9.0,  width * 0.05);

            NSFont *titleFont = [NSFont systemFontOfSize:titleSize weight:NSFontWeightBold];
            NSFont *bodyFont  = [NSFont systemFontOfSize:bodySize  weight:NSFontWeightRegular];

            NSColor *dark = [NSColor colorWithCalibratedRed:0.078 green:0.078 blue:0.075 alpha:1.0];
            NSColor *gray = [NSColor colorWithCalibratedRed:0.69 green:0.682 blue:0.647 alpha:1.0];

            NSMutableParagraphStyle *titleStyle = [[NSMutableParagraphStyle alloc] init];
            titleStyle.lineBreakMode = NSLineBreakByTruncatingTail;
            titleStyle.lineSpacing = 1.0;

            NSDictionary *titleAttrs = @{
                NSFontAttributeName: titleFont,
                NSForegroundColorAttributeName: dark,
                NSParagraphStyleAttributeName: titleStyle
            };
            NSDictionary *bodyAttrs = @{
                NSFontAttributeName: bodyFont,
                NSForegroundColorAttributeName: gray,
                NSParagraphStyleAttributeName: titleStyle
            };

            CGFloat titleY = height - padding - titleSize * 2.2;
            NSRect titleRect = NSMakeRect(padding, titleY, width - padding * 2, titleSize * 2.4);
            [title drawInRect:titleRect withAttributes:titleAttrs];

            /* Linha de accent abaixo do título. */
            [orange setFill];
            NSRectFill(NSMakeRect(padding, titleY - 4, width * 0.15, 2));

            CGFloat paraY = padding;
            NSRect paraRect = NSMakeRect(padding, paraY, width - padding * 2, titleY - padding * 2 - 4);
            [para drawInRect:paraRect withAttributes:bodyAttrs];
        }

        /* Badge "Z" canto inferior direito (sempre, mesmo em 16x16). */
        CGFloat badgeSize = MAX(14.0, width * 0.18);
        NSRect badgeRect = NSMakeRect(width - badgeSize - 6, 6, badgeSize, badgeSize);
        [orange setFill];
        NSBezierPath *badgePath = [NSBezierPath bezierPathWithRoundedRect:badgeRect xRadius:badgeSize * 0.2 yRadius:badgeSize * 0.2];
        [badgePath fill];

        NSFont *zFont = [NSFont boldSystemFontOfSize:badgeSize * 0.7];
        NSDictionary *zAttrs = @{
            NSFontAttributeName: zFont,
            NSForegroundColorAttributeName: [NSColor whiteColor]
        };
        NSString *zStr = @"Z";
        NSSize zSize = [zStr sizeWithAttributes:zAttrs];
        NSPoint zPoint = NSMakePoint(NSMidX(badgeRect) - zSize.width / 2, NSMidY(badgeRect) - zSize.height / 2);
        [zStr drawAtPoint:zPoint withAttributes:zAttrs];

        [image unlockFocus];

        if (QLThumbnailRequestIsCancelled(thumbnail)) {
            return noErr;
        }

        NSRect proposed = NSMakeRect(0, 0, size.width, size.height);
        CGImageRef cgImage = [image CGImageForProposedRect:&proposed context:nil hints:nil];
        if (cgImage == NULL) {
            return noErr;
        }

        NSDictionary *props = @{
            (__bridge NSString *)kQLThumbnailPropertyExtensionKey: @"md"
        };
        QLThumbnailRequestSetImage(thumbnail, cgImage, (__bridge CFDictionaryRef)props);
    }
    return noErr;
}

void CancelThumbnailGeneration(void *thisInterface, QLThumbnailRequestRef thumbnail) {
    (void)thisInterface;
    (void)thumbnail;
    /* Cancelamento cooperativo via QLThumbnailRequestIsCancelled. */
}
