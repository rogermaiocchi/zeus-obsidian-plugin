//
//  GetMetadataForFile.m
//  ZeusMarkdownImporter
//
//  Spotlight metadata extractor for Obsidian-flavored Markdown notes.
//
//  Parses YAML frontmatter (tipo, status, tags, aliases, zeus_*) plus body
//  structure (headings, [[wikilinks]], #tags, H1) and populates Spotlight
//  attributes so `mdfind` can locate notes by their semantic metadata,
//  not just raw text.
//
//  No external dependencies — only Foundation / CoreFoundation.
//

#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>

// Forward declaration matching the Apple MDImporter contract.
Boolean GetMetadataForFile(void *thisInterface,
                           CFMutableDictionaryRef attributes,
                           CFStringRef contentTypeUTI,
                           CFStringRef pathToFile);

#pragma mark - Helpers

// Strip surrounding quotes (single or double) from a YAML scalar.
static NSString *ZMUnquote(NSString *value) {
    if (value.length < 2) return value;
    unichar first = [value characterAtIndex:0];
    unichar last  = [value characterAtIndex:value.length - 1];
    if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
        return [value substringWithRange:NSMakeRange(1, value.length - 2)];
    }
    return value;
}

// Parse a YAML scalar list. Accepts:
//   tags: [a, b, c]
//   tags:
//     - a
//     - b
// Returns an NSArray<NSString *> of trimmed values (no quotes).
static NSArray<NSString *> *ZMParseList(NSString *inlineValue, NSArray<NSString *> *followingLines, NSUInteger *consumedOut) {
    NSMutableArray<NSString *> *out = [NSMutableArray array];
    NSCharacterSet *ws = [NSCharacterSet whitespaceCharacterSet];

    NSString *trimmed = [inlineValue stringByTrimmingCharactersInSet:ws];
    if (trimmed.length > 0 && [trimmed hasPrefix:@"["] && [trimmed hasSuffix:@"]"]) {
        // Inline flow style: [a, b, c]
        NSString *inner = [trimmed substringWithRange:NSMakeRange(1, trimmed.length - 2)];
        for (NSString *raw in [inner componentsSeparatedByString:@","]) {
            NSString *item = ZMUnquote([raw stringByTrimmingCharactersInSet:ws]);
            if (item.length > 0) [out addObject:item];
        }
        if (consumedOut) *consumedOut = 0;
        return out;
    }

    // Block style on following lines starting with "- ".
    NSUInteger consumed = 0;
    for (NSString *line in followingLines) {
        NSString *t = [line stringByTrimmingCharactersInSet:ws];
        if ([t hasPrefix:@"- "]) {
            NSString *item = ZMUnquote([[t substringFromIndex:2] stringByTrimmingCharactersInSet:ws]);
            if (item.length > 0) [out addObject:item];
            consumed++;
        } else {
            break;
        }
    }
    if (consumedOut) *consumedOut = consumed;
    return out;
}

// Tokenize `content` into (frontmatter dict, body string).
// frontmatter is nil when the note has no `---\n...---\n` opening block.
static void ZMSplitFrontmatter(NSString *content,
                               NSDictionary<NSString *, id> **frontmatterOut,
                               NSString **bodyOut) {
    NSArray<NSString *> *lines = [content componentsSeparatedByString:@"\n"];
    if (lines.count < 2 || ![[lines[0] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] isEqualToString:@"---"]) {
        if (frontmatterOut) *frontmatterOut = nil;
        if (bodyOut) *bodyOut = content;
        return;
    }

    NSUInteger closing = NSNotFound;
    for (NSUInteger i = 1; i < lines.count; i++) {
        NSString *t = [lines[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if ([t isEqualToString:@"---"] || [t isEqualToString:@"..."]) {
            closing = i;
            break;
        }
    }
    if (closing == NSNotFound) {
        if (frontmatterOut) *frontmatterOut = nil;
        if (bodyOut) *bodyOut = content;
        return;
    }

    NSMutableDictionary<NSString *, id> *fm = [NSMutableDictionary dictionary];
    NSUInteger i = 1;
    while (i < closing) {
        NSString *line = lines[i];
        NSString *trimmed = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (trimmed.length == 0 || [trimmed hasPrefix:@"#"]) { i++; continue; }

        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound) { i++; continue; }

        NSString *key = [[line substringToIndex:colon.location] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString *rawValue = (colon.location + 1 < line.length)
            ? [line substringFromIndex:colon.location + 1]
            : @"";
        NSString *value = [rawValue stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];

        if (value.length == 0) {
            // Could be a block-style list following.
            NSArray<NSString *> *following = (i + 1 < closing)
                ? [lines subarrayWithRange:NSMakeRange(i + 1, closing - (i + 1))]
                : @[];
            NSUInteger consumed = 0;
            NSArray<NSString *> *list = ZMParseList(@"", following, &consumed);
            if (list.count > 0) {
                fm[key] = list;
                i += 1 + consumed;
                continue;
            }
            fm[key] = @"";
            i++;
            continue;
        }

        if ([value hasPrefix:@"["]) {
            NSArray<NSString *> *list = ZMParseList(value, @[], NULL);
            fm[key] = list;
        } else {
            fm[key] = ZMUnquote(value);
        }
        i++;
    }

    if (frontmatterOut) *frontmatterOut = fm;
    NSArray<NSString *> *bodyLines = (closing + 1 < lines.count)
        ? [lines subarrayWithRange:NSMakeRange(closing + 1, lines.count - closing - 1)]
        : @[];
    if (bodyOut) *bodyOut = [bodyLines componentsJoinedByString:@"\n"];
}

// Coerce an arbitrary frontmatter value to NSArray<NSString *>.
static NSArray<NSString *> *ZMAsArray(id value) {
    if ([value isKindOfClass:[NSArray class]]) return (NSArray *)value;
    if ([value isKindOfClass:[NSString class]] && ((NSString *)value).length > 0) return @[ value ];
    return @[];
}

// Extract H1/H2/H3 headings, wikilinks, and inline #tags from body.
static void ZMExtractBodyStructure(NSString *body,
                                   NSMutableArray<NSString *> *headings,
                                   NSMutableArray<NSString *> *wikilinks,
                                   NSMutableArray<NSString *> *inlineTags,
                                   NSString **h1Out) {
    NSString *firstH1 = nil;
    NSCharacterSet *ws = [NSCharacterSet whitespaceCharacterSet];

    for (NSString *line in [body componentsSeparatedByString:@"\n"]) {
        NSString *t = [line stringByTrimmingCharactersInSet:ws];
        if ([t hasPrefix:@"# "]) {
            NSString *h = [[t substringFromIndex:2] stringByTrimmingCharactersInSet:ws];
            if (h.length > 0) {
                [headings addObject:h];
                if (firstH1 == nil) firstH1 = h;
            }
        } else if ([t hasPrefix:@"## "]) {
            [headings addObject:[[t substringFromIndex:3] stringByTrimmingCharactersInSet:ws]];
        } else if ([t hasPrefix:@"### "]) {
            [headings addObject:[[t substringFromIndex:4] stringByTrimmingCharactersInSet:ws]];
        }
    }

    NSError *err = nil;
    NSRegularExpression *wikiRe = [NSRegularExpression
        regularExpressionWithPattern:@"\\[\\[([^\\]|#]+?)(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]"
        options:0 error:&err];
    if (wikiRe) {
        [wikiRe enumerateMatchesInString:body
                                 options:0
                                   range:NSMakeRange(0, body.length)
                              usingBlock:^(NSTextCheckingResult *m, NSMatchingFlags flags, BOOL *stop) {
            if (m.numberOfRanges < 2) return;
            NSString *target = [[body substringWithRange:[m rangeAtIndex:1]] stringByTrimmingCharactersInSet:ws];
            if (target.length > 0) [wikilinks addObject:target];
        }];
    }

    NSRegularExpression *tagRe = [NSRegularExpression
        regularExpressionWithPattern:@"(?:^|\\s)#([A-Za-z0-9_/\\-]+)"
        options:0 error:&err];
    if (tagRe) {
        [tagRe enumerateMatchesInString:body
                                options:0
                                  range:NSMakeRange(0, body.length)
                             usingBlock:^(NSTextCheckingResult *m, NSMatchingFlags flags, BOOL *stop) {
            if (m.numberOfRanges < 2) return;
            NSString *tag = [body substringWithRange:[m rangeAtIndex:1]];
            if (tag.length > 0) [inlineTags addObject:tag];
        }];
    }

    if (h1Out) *h1Out = firstH1;
}

#pragma mark - Entry point

Boolean GetMetadataForFile(void *thisInterface,
                           CFMutableDictionaryRef attributes,
                           CFStringRef contentTypeUTI,
                           CFStringRef pathToFile) {
    @autoreleasepool {
        if (pathToFile == NULL || attributes == NULL) return FALSE;

        NSString *path = (__bridge NSString *)pathToFile;
        NSError *err = nil;
        NSString *content = [NSString stringWithContentsOfFile:path
                                                      encoding:NSUTF8StringEncoding
                                                         error:&err];
        if (content == nil || err != nil) return FALSE;

        NSDictionary<NSString *, id> *fm = nil;
        NSString *body = nil;
        ZMSplitFrontmatter(content, &fm, &body);
        if (body == nil) body = content;

        NSMutableArray<NSString *> *headings   = [NSMutableArray array];
        NSMutableArray<NSString *> *wikilinks  = [NSMutableArray array];
        NSMutableArray<NSString *> *inlineTags = [NSMutableArray array];
        NSString *firstH1 = nil;
        ZMExtractBodyStructure(body, headings, wikilinks, inlineTags, &firstH1);

        // --- kMDItemTextContent: body without frontmatter ---
        CFDictionarySetValue(attributes,
                             (__bridge const void *)((__bridge NSString *)kMDItemTextContent),
                             (__bridge const void *)body);

        // --- kMDItemTitle: frontmatter title → first H1 → filename stem ---
        NSString *title = nil;
        if (fm[@"title"] && [fm[@"title"] isKindOfClass:[NSString class]] && ((NSString *)fm[@"title"]).length > 0) {
            title = fm[@"title"];
        } else if (firstH1.length > 0) {
            title = firstH1;
        } else {
            title = [[path lastPathComponent] stringByDeletingPathExtension];
        }
        if (title.length > 0) {
            CFDictionarySetValue(attributes,
                                 (__bridge const void *)((__bridge NSString *)kMDItemTitle),
                                 (__bridge const void *)title);
        }

        // --- kMDItemKeywords: union(tags, aliases, headings, zeus_concepts, inline #tags, wikilinks) ---
        NSMutableOrderedSet<NSString *> *keywords = [NSMutableOrderedSet orderedSet];
        if (fm) {
            [keywords addObjectsFromArray:ZMAsArray(fm[@"tags"])];
            [keywords addObjectsFromArray:ZMAsArray(fm[@"aliases"])];
            [keywords addObjectsFromArray:ZMAsArray(fm[@"zeus_concepts"])];
            [keywords addObjectsFromArray:ZMAsArray(fm[@"zeus_related"])];
            id status = fm[@"status"];
            if ([status isKindOfClass:[NSString class]] && ((NSString *)status).length > 0) {
                [keywords addObject:[NSString stringWithFormat:@"status:%@", status]];
            }
            id tipo = fm[@"tipo"] ?: fm[@"type"];
            if ([tipo isKindOfClass:[NSString class]] && ((NSString *)tipo).length > 0) {
                [keywords addObject:[NSString stringWithFormat:@"tipo:%@", tipo]];
            }
            id domain = fm[@"zeus_domain"];
            if ([domain isKindOfClass:[NSString class]] && ((NSString *)domain).length > 0) {
                [keywords addObject:[NSString stringWithFormat:@"domain:%@", domain]];
            }
        }
        [keywords addObjectsFromArray:headings];
        [keywords addObjectsFromArray:wikilinks];
        [keywords addObjectsFromArray:inlineTags];

        if (keywords.count > 0) {
            NSArray *kwArray = [keywords array];
            CFDictionarySetValue(attributes,
                                 (__bridge const void *)((__bridge NSString *)kMDItemKeywords),
                                 (__bridge const void *)kwArray);
        }

        // --- kMDItemAuthors: frontmatter author / authors ---
        NSArray *authors = nil;
        if (fm[@"authors"]) {
            authors = ZMAsArray(fm[@"authors"]);
        } else if (fm[@"author"] && [fm[@"author"] isKindOfClass:[NSString class]]) {
            authors = @[ fm[@"author"] ];
        }
        if (authors.count > 0) {
            CFDictionarySetValue(attributes,
                                 (__bridge const void *)((__bridge NSString *)kMDItemAuthors),
                                 (__bridge const void *)authors);
        }

        // --- kMDItemDescription: zeus_summary → frontmatter description ---
        NSString *summary = nil;
        if (fm[@"zeus_summary"] && [fm[@"zeus_summary"] isKindOfClass:[NSString class]]) {
            summary = fm[@"zeus_summary"];
        } else if (fm[@"description"] && [fm[@"description"] isKindOfClass:[NSString class]]) {
            summary = fm[@"description"];
        }
        if (summary.length > 0) {
            CFDictionarySetValue(attributes,
                                 (__bridge const void *)((__bridge NSString *)kMDItemDescription),
                                 (__bridge const void *)summary);
        }

        return TRUE;
    }
}
