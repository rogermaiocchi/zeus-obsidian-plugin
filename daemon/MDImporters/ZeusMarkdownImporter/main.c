/*
 *  main.c
 *  ZeusMarkdownImporter
 *
 *  CFPlugIn factory boilerplate for a Spotlight metadata importer.
 *  Lifted from Apple's "MDImporter" Xcode template (Carbon-style plugin
 *  factory). The Spotlight server (`mdimport`/`mds`) loads this bundle,
 *  calls MetadataImporterPluginFactory() to obtain a COM-style interface
 *  whose GetMetadataForFile slot points at our parser.
 *
 *  Do not change the type/interface UUIDs below — they are Apple-defined
 *  contracts. Only the FACTORY UUID matches the entry in Info.plist
 *  (CFPlugInFactories).
 */

#include <CoreFoundation/CoreFoundation.h>
#include <CoreFoundation/CFPlugInCOM.h>

// --- Forward declaration of the metadata extractor implemented in
// GetMetadataForFile.m ---
Boolean GetMetadataForFile(void *thisInterface,
                           CFMutableDictionaryRef attributes,
                           CFStringRef contentTypeUTI,
                           CFStringRef pathToFile);

// --- Apple-defined UUIDs ---
//
// Plugin type UUID identifying "Spotlight metadata importer":
//   8B08C4BF-415B-11D8-B3F1-0003936726FC
//
// Interface UUID for the importer v-table:
//   6EBC27C4-89E5-11D8-9D75-000A959BB1C0

#define PLUGIN_TYPE_UUID \
    (CFUUIDGetConstantUUIDWithBytes(NULL, \
        0x8B, 0x08, 0xC4, 0xBF, 0x41, 0x5B, 0x11, 0xD8, \
        0xB3, 0xF1, 0x00, 0x03, 0x93, 0x67, 0x26, 0xFC))

#define IMPORTER_INTERFACE_UUID \
    (CFUUIDGetConstantUUIDWithBytes(NULL, \
        0x6E, 0xBC, 0x27, 0xC4, 0x89, 0xE5, 0x11, 0xD8, \
        0x9D, 0x75, 0x00, 0x0A, 0x95, 0x9B, 0xB1, 0xC0))

// --- Factory UUID — must match CFPlugInFactories key in Info.plist ---
//   20B7BB87-8919-4FF0-85D6-7BADFC17486B

#define FACTORY_UUID \
    (CFUUIDGetConstantUUIDWithBytes(NULL, \
        0x20, 0xB7, 0xBB, 0x87, 0x89, 0x19, 0x4F, 0xF0, \
        0x85, 0xD6, 0x7B, 0xAD, 0xFC, 0x17, 0x48, 0x6B))

#pragma mark - Interface v-table

// COM-style v-table the Spotlight server casts our instance to.
typedef struct __MetadataImporterPluginType {
    MDImporterInterfaceStruct *conduitInterface;
    CFUUIDRef                  factoryID;
    UInt32                     refCount;
} MetadataImporterPluginType;

// Forward declarations.
static MetadataImporterPluginType *AllocMetadataImporterPluginType(CFUUIDRef inFactoryID);
static void DeallocMetadataImporterPluginType(MetadataImporterPluginType *thisInstance);
static HRESULT MetadataImporterQueryInterface(void *thisInstance, REFIID iid, LPVOID *ppv);
static ULONG   MetadataImporterPluginAddRef(void *thisInstance);
static ULONG   MetadataImporterPluginRelease(void *thisInstance);

// Static interface — every instance points at the same v-table.
static MDImporterInterfaceStruct testInterfaceFtbl = {
    NULL,                                // IUNKNOWN_C_GUTS::_reserved
    MetadataImporterQueryInterface,      // IUNKNOWN_C_GUTS::QueryInterface
    MetadataImporterPluginAddRef,        // IUNKNOWN_C_GUTS::AddRef
    MetadataImporterPluginRelease,       // IUNKNOWN_C_GUTS::Release
    GetMetadataForFile                   // Spotlight calls this per file
};

#pragma mark - Lifecycle

static MetadataImporterPluginType *
AllocMetadataImporterPluginType(CFUUIDRef inFactoryID) {
    MetadataImporterPluginType *theNewInstance =
        (MetadataImporterPluginType *)malloc(sizeof(MetadataImporterPluginType));
    if (theNewInstance == NULL) return NULL;

    memset(theNewInstance, 0, sizeof(MetadataImporterPluginType));
    theNewInstance->conduitInterface = &testInterfaceFtbl;
    theNewInstance->factoryID        = (CFUUIDRef)CFRetain(inFactoryID);

    // Tell CFPlugIn one more instance of this factory is alive.
    CFPlugInAddInstanceForFactory(inFactoryID);

    theNewInstance->refCount = 1;
    return theNewInstance;
}

static void
DeallocMetadataImporterPluginType(MetadataImporterPluginType *thisInstance) {
    if (thisInstance == NULL) return;
    CFUUIDRef theFactoryID = thisInstance->factoryID;
    free(thisInstance);
    if (theFactoryID) {
        CFPlugInRemoveInstanceForFactory(theFactoryID);
        CFRelease(theFactoryID);
    }
}

#pragma mark - IUnknown

static HRESULT
MetadataImporterQueryInterface(void *thisInstance, REFIID iid, LPVOID *ppv) {
    CFUUIDRef interfaceID = CFUUIDCreateFromUUIDBytes(kCFAllocatorDefault, iid);
    if (interfaceID == NULL) {
        if (ppv) *ppv = NULL;
        return E_INVALIDARG;
    }

    if (CFEqual(interfaceID, IMPORTER_INTERFACE_UUID) ||
        CFEqual(interfaceID, IUnknownUUID)) {
        ((MetadataImporterPluginType *)thisInstance)->conduitInterface->AddRef(thisInstance);
        *ppv = thisInstance;
        CFRelease(interfaceID);
        return S_OK;
    }

    *ppv = NULL;
    CFRelease(interfaceID);
    return E_NOINTERFACE;
}

static ULONG
MetadataImporterPluginAddRef(void *thisInstance) {
    ((MetadataImporterPluginType *)thisInstance)->refCount += 1;
    return ((MetadataImporterPluginType *)thisInstance)->refCount;
}

static ULONG
MetadataImporterPluginRelease(void *thisInstance) {
    MetadataImporterPluginType *self = (MetadataImporterPluginType *)thisInstance;
    self->refCount -= 1;
    if (self->refCount == 0) {
        DeallocMetadataImporterPluginType(self);
        return 0;
    }
    return self->refCount;
}

#pragma mark - Factory entry point

// Symbol name MUST match `CFPlugInFactories` value in Info.plist.
void *MetadataImporterPluginFactory(CFAllocatorRef allocator, CFUUIDRef typeID);

void *
MetadataImporterPluginFactory(CFAllocatorRef allocator, CFUUIDRef typeID) {
    (void)allocator;
    if (CFEqual(typeID, PLUGIN_TYPE_UUID)) {
        MetadataImporterPluginType *result = AllocMetadataImporterPluginType(FACTORY_UUID);
        return result;
    }
    return NULL;
}
