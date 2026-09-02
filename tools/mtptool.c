// ls / get / put for one MTP device, resolving a slash-separated path inside a
// single session. Object handles cannot be carried between sessions -- looking
// up a folder id in one run and using it in the next is what PTP calls an
// Invalid Object Handle, which is where libmtp's own tools leave you.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <libmtp.h>

#define NOT_FOUND 0xFFFFFFFFu

// Walk "a/b/c" one level at a time. An uncached device hands back children on
// request rather than a whole tree, which is the trade for being able to list
// a single folder without reading the entire filesystem first.
static uint32_t resolve(LIBMTP_mtpdevice_t *dev, uint32_t storage, const char *path) {
  char *copy = strdup(path), *save = NULL;
  uint32_t at = 0;   // 0 is the storage root
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    uint32_t next = NOT_FOUND;
    LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, at);
    while (f) {
      LIBMTP_file_t *n = f->next;
      if (next == NOT_FOUND && f->filetype == LIBMTP_FILETYPE_FOLDER
          && f->filename && strcmp(f->filename, part) == 0) next = f->item_id;
      LIBMTP_destroy_file_t(f);
      f = n;
    }
    if (next == NOT_FOUND) { free(copy); return NOT_FOUND; }
    at = next;
  }
  free(copy);
  return at;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: mtptool ls <path>\n       mtptool slots <path> <outdir>\n       mtptool get <path> <name> <local>\n       mtptool put <local> <path> <name>\n       mtptool rm <path> <name>\n");
    return 2;
  }
  const char *cmd = argv[1];

  LIBMTP_Init();
  // Uncached: the cached open pre-reads the whole tree and then refuses
  // Get_Files_And_Folders, which is the only way to list one folder cheaply.
  LIBMTP_raw_device_t *raw = NULL;
  int nraw = 0;
  if (LIBMTP_Detect_Raw_Devices(&raw, &nraw) != LIBMTP_ERROR_NONE || nraw < 1) {
    fprintf(stderr, "no mtp device\n");
    return 1;
  }
  LIBMTP_mtpdevice_t *dev = LIBMTP_Open_Raw_Device_Uncached(&raw[0]);
  free(raw);
  // Whoever has it, macOS gives USB interfaces out exclusively, so naming a
  // suspect here only sends you chasing the wrong process. ioreg tells you:
  //   ioreg -p IOService -w0 -r -n "$(the device's USB product name)"
  // lists an AppleUSBHostDeviceUserClient per holder.
  if (!dev) { fprintf(stderr, "could not open the device (another process is holding it)\n"); return 1; }
  // A session that came up the hard way -- PTP_ERROR_IO, libmtp resets the USB
  // interface and reopens -- can arrive with no storage enumerated at all. The
  // old code fell back to storage 0 there, walked the path from nowhere, found
  // nothing, and reported "no such folder" about a folder that was never looked
  // for. Ask twice, then say which of the two things actually went wrong.
  LIBMTP_Get_Storage(dev, LIBMTP_STORAGE_SORTBY_NOTSORTED);
  if (!dev->storage) LIBMTP_Get_Storage(dev, LIBMTP_STORAGE_SORTBY_NOTSORTED);
  if (!dev->storage) {
    fprintf(stderr, "device reported no storage — the session did not come up cleanly\n");
    LIBMTP_Release_Device(dev);
    return 1;
  }
  uint32_t storage = dev->storage->id;
  const char *path = strcmp(cmd, "put") == 0 ? argv[3] : argv[2];
  uint32_t dir = resolve(dev, storage, path);
  if (dir == NOT_FOUND) { fprintf(stderr, "no such folder: %s\n", path); return 1; }

  int rc = 0;
  if (strcmp(cmd, "ls") == 0) {
    // Folders first, then files, as "kind\tid\tsize\tname".
    for (LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, dir); f; ) {
      LIBMTP_file_t *next = f->next;
      printf("%s\t%u\t%llu\t%s\n", f->filetype == LIBMTP_FILETYPE_FOLDER ? "d" : "f",
             f->item_id, (unsigned long long) f->filesize, f->filename ? f->filename : "");
      LIBMTP_destroy_file_t(f);
      f = next;
    }
  } else if (strcmp(cmd, "get") == 0) {
    uint32_t id = 0;
    for (LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, dir); f; f = f->next)
      if (f->filename && strcmp(f->filename, argv[3]) == 0) { id = f->item_id; break; }
    if (!id) { fprintf(stderr, "no such file: %s\n", argv[3]); return 1; }
    rc = LIBMTP_Get_File_To_File(dev, id, argv[4], NULL, NULL);
  } else if (strcmp(cmd, "put") == 0) {
    struct stat st;
    if (stat(argv[2], &st) != 0) { perror("stat"); return 1; }
    // MTP has no overwrite: a same-named object has to go first.
    for (LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, dir); f; f = f->next)
      if (f->filename && strcmp(f->filename, argv[4]) == 0) LIBMTP_Delete_Object(dev, f->item_id);

    LIBMTP_file_t *nf = LIBMTP_new_file_t();
    nf->filesize = (uint64_t) st.st_size;
    nf->filename = strdup(argv[4]);
    nf->filetype = LIBMTP_FILETYPE_UNKNOWN;
    nf->parent_id = dir;
    nf->storage_id = storage;
    rc = LIBMTP_Send_File_From_File(dev, argv[2], nf, NULL, NULL);
    if (rc == 0) printf("%u\n", nf->item_id);
    LIBMTP_destroy_file_t(nf);
  } else if (strcmp(cmd, "slots") == 0) {
    // Every mission folder and its kmz, pulled in one session. Opening a session
    // costs seconds on this controller, so doing it per slot makes the panel
    // look broken; doing it once makes it merely slow.
    const char *outdir = argv[3];
    for (LIBMTP_file_t *d = LIBMTP_Get_Files_And_Folders(dev, storage, dir); d; d = d->next) {
      if (d->filetype != LIBMTP_FILETYPE_FOLDER || !d->filename) continue;
      char want[512], local[1024];
      snprintf(want, sizeof want, "%s.kmz", d->filename);
      int got = 0;
      for (LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, d->item_id); f; f = f->next) {
        if (!f->filename || strcmp(f->filename, want) != 0) continue;
        snprintf(local, sizeof local, "%s/%s", outdir, want);
        got = LIBMTP_Get_File_To_File(dev, f->item_id, local, NULL, NULL) == 0;
        break;
      }
      printf("%s\t%s\n", d->filename, got ? "kmz" : "empty");
    }
  } else if (strcmp(cmd, "rm") == 0) {
    rc = 1;
    for (LIBMTP_file_t *f = LIBMTP_Get_Files_And_Folders(dev, storage, dir); f; f = f->next)
      if (f->filename && strcmp(f->filename, argv[3]) == 0) rc = LIBMTP_Delete_Object(dev, f->item_id);
  } else {
    fprintf(stderr, "unknown command: %s\n", cmd);
    rc = 2;
  }

  if (rc != 0) { LIBMTP_Dump_Errorstack(dev); LIBMTP_Clear_Errorstack(dev); }
  LIBMTP_Release_Device(dev);
  return rc == 0 ? 0 : 1;
}
