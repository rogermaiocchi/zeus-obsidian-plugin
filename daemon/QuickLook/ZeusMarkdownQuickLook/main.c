/*
 * main.c — QuickLookGeneratorPluginFactory boilerplate
 * ============================================================================
 * Zeus Markdown Quick Look generator — Carbon-style CFPlugIn factory.
 *
 * Apple deprecou QLGenerator em macOS Sonoma (14) em favor de QLPreviewExtension
 * (app extension entregue dentro de host .app). O caminho legacy continua
 * funcional para distribuição standalone — usuário copia .qlgenerator pra
 * ~/Library/QuickLook/ e roda `qlmanage -r`. Ver README.md.
 *
 * Layout do factory:
 *   - GeneratePreviewForURL: rende HTML rico ao apertar SPACE no Finder.
 *   - GenerateThumbnailForURL: renderiza ícone com H1 + primeiro parágrafo.
 *   - CancelPreviewGeneration / CancelThumbnailGeneration: stubs.
 *   - QuickLookGeneratorPluginFactory: vtable + COM-style refcount.
 *
 * Referência: Quick Look Programming Guide §Implementing a Quick Look Generator.
 * ============================================================================
 */

#include <CoreFoundation/CoreFoundation.h>
#include <CoreServices/CoreServices.h>
#include <QuickLook/QuickLook.h>

/* Forward decls — implementações em GeneratePreviewForURL.m e GenerateThumbnailForURL.m. */
OSStatus GeneratePreviewForURL(void *thisInterface,
                               QLPreviewRequestRef preview,
                               CFURLRef url,
                               CFStringRef contentTypeUTI,
                               CFDictionaryRef options);
void CancelPreviewGeneration(void *thisInterface,
                             QLPreviewRequestRef preview);

OSStatus GenerateThumbnailForURL(void *thisInterface,
                                 QLThumbnailRequestRef thumbnail,
                                 CFURLRef url,
                                 CFStringRef contentTypeUTI,
                                 CFDictionaryRef options,
                                 CGSize maxSize);
void CancelThumbnailGeneration(void *thisInterface,
                               QLThumbnailRequestRef thumbnail);

/* ----------------------------------------------------------------------------
 * Plugin factory UUID — espelha CFPlugInFactories no Info.plist.
 * Se você gerar UUIDs novos, regenere ambos juntos.
 * -------------------------------------------------------------------------- */
#define PLUGIN_ID "7EDDEC09-637E-4BBC-8502-E789EB8F29EB"

/* ----------------------------------------------------------------------------
 * vtable + instância — formato exigido pelo CFPlugIn / QuickLookGenerator.
 * -------------------------------------------------------------------------- */
typedef struct __ZeusQLPlugin {
    QLGeneratorInterfaceStruct *conduitInterface;
    CFUUIDRef factoryID;
    UInt32 refCount;
} ZeusQLPlugin;

static HRESULT  ZeusQLPlugin_QueryInterface(void *thisInstance, REFIID iid, LPVOID *ppv);
static ULONG    ZeusQLPlugin_AddRef(void *thisInstance);
static ULONG    ZeusQLPlugin_Release(void *thisInstance);
static void     ZeusQLPlugin_Dealloc(ZeusQLPlugin *thisInstance);

static QLGeneratorInterfaceStruct kZeusQLPluginInterface = {
    NULL,
    ZeusQLPlugin_QueryInterface,
    ZeusQLPlugin_AddRef,
    ZeusQLPlugin_Release,
    GenerateThumbnailForURL,
    CancelThumbnailGeneration,
    GeneratePreviewForURL,
    CancelPreviewGeneration
};

static ZeusQLPlugin *ZeusQLPlugin_Alloc(CFUUIDRef factoryID) {
    ZeusQLPlugin *self = (ZeusQLPlugin *)malloc(sizeof(ZeusQLPlugin));
    if (self == NULL) {
        return NULL;
    }
    self->conduitInterface = &kZeusQLPluginInterface;
    self->factoryID = (CFUUIDRef)CFRetain(factoryID);
    self->refCount = 1;
    CFPlugInAddInstanceForFactory(factoryID);
    return self;
}

static void ZeusQLPlugin_Dealloc(ZeusQLPlugin *self) {
    CFUUIDRef factoryID = self->factoryID;
    free(self);
    if (factoryID) {
        CFPlugInRemoveInstanceForFactory(factoryID);
        CFRelease(factoryID);
    }
}

static HRESULT ZeusQLPlugin_QueryInterface(void *thisInstance, REFIID iid, LPVOID *ppv) {
    CFUUIDRef interfaceID = CFUUIDCreateFromUUIDBytes(kCFAllocatorDefault, iid);
    if (interfaceID == NULL) {
        return E_INVALIDARG;
    }

    if (CFEqual(interfaceID, kQLGeneratorCallbacksInterfaceID) ||
        CFEqual(interfaceID, IUnknownUUID)) {
        ((ZeusQLPlugin *)thisInstance)->conduitInterface->AddRef(thisInstance);
        *ppv = thisInstance;
        CFRelease(interfaceID);
        return S_OK;
    }

    *ppv = NULL;
    CFRelease(interfaceID);
    return E_NOINTERFACE;
}

static ULONG ZeusQLPlugin_AddRef(void *thisInstance) {
    ((ZeusQLPlugin *)thisInstance)->refCount += 1;
    return ((ZeusQLPlugin *)thisInstance)->refCount;
}

static ULONG ZeusQLPlugin_Release(void *thisInstance) {
    ZeusQLPlugin *self = (ZeusQLPlugin *)thisInstance;
    self->refCount -= 1;
    if (self->refCount == 0) {
        ZeusQLPlugin_Dealloc(self);
        return 0;
    }
    return self->refCount;
}

/* ----------------------------------------------------------------------------
 * QuickLookGeneratorPluginFactory — entry-point exigido por CFPlugIn.
 * O loader olha esse símbolo via CFPlugInFactories (Info.plist).
 * -------------------------------------------------------------------------- */
void *QuickLookGeneratorPluginFactory(CFAllocatorRef allocator, CFUUIDRef typeID);

void *QuickLookGeneratorPluginFactory(CFAllocatorRef allocator, CFUUIDRef typeID) {
    (void)allocator;
    if (!CFEqual(typeID, kQLGeneratorTypeID)) {
        return NULL;
    }
    CFUUIDRef factoryID = CFUUIDCreateFromString(kCFAllocatorDefault, CFSTR(PLUGIN_ID));
    ZeusQLPlugin *self = ZeusQLPlugin_Alloc(factoryID);
    CFRelease(factoryID);
    return self;
}
