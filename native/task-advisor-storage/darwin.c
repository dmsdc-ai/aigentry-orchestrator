/*
 * advisor-storage-provenance — Darwin helper.
 *
 * Answers one question about one already-resolved directory: is the volume
 * backing it internal, fixed, removable or reached over a network. It implements
 * the Darwin selection in input/ADAPTER-DECISION.md: statfs(2) for the mount
 * point and format, then Disk Arbitration for that one volume.
 *
 * Deliberate non-behaviours:
 *   - No device or volume ENUMERATION. DADiskCreateFromVolumePath names exactly
 *     the volume the caller's path resolved to; nothing iterates other disks.
 *   - No elevation. Ordinary process permissions only; if the description cannot
 *     be obtained the answer is `unknown`, never a retry with more authority.
 *   - No file CONTENT is opened or read, and no volume name, UUID, device serial,
 *     BSD name or user-visible string is ever printed. Only booleans and the
 *     device number the caller can already observe itself.
 *   - No inference from f_fstypename or mount-point spelling. `statfs` reports a
 *     FORMAT; a format is not provenance.
 *
 * Output is exactly one line on stdout and nothing else, ever:
 *
 *   advisor-storage-provenance-v1 status=S class=C dev=D internal=I removable=R
 *
 *   S  ok | denied | unsupported | error
 *   C  local-fixed | removable | network | unknown   (unknown unless S is ok)
 *   D  decimal st_dev of the resolved target, or `u`
 *   I  1 | 0 | u   device reported internal
 *   R  1 | 0 | u   media reported removable
 *
 * The process always exits 0 after printing a well-formed line, so that a refusal
 * is parsed as a refusal rather than mistaken for a crash. It exits non-zero only
 * when it could not even print.
 */

#include <CoreFoundation/CoreFoundation.h>
#include <DiskArbitration/DiskArbitration.h>

#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROTOCOL "advisor-storage-provenance-v1"

/* Hard self-bound: this helper may never outlive a caller's patience. */
#define WATCHDOG_SECONDS 2

static int emit(const char *status, const char *klass, const char *dev,
                const char *internal, const char *removable) {
  if (printf(PROTOCOL " status=%s class=%s dev=%s internal=%s removable=%s\n",
             status, klass, dev, internal, removable) < 0) {
    return 1;
  }
  return fflush(stdout) == 0 ? 0 : 1;
}

static int refuse(const char *status) { return emit(status, "unknown", "u", "u", "u"); }

/*
 * Read one documented CFBoolean key. A missing key, or a key of another type, is
 * not a false: it means Disk Arbitration did not describe this property for this
 * volume, which is an honest `unknown` rather than a licence to assume the safe
 * answer was intended.
 */
static int boolean_key(CFDictionaryRef description, CFStringRef key, int *out) {
  CFTypeRef value = CFDictionaryGetValue(description, key);
  if (value == NULL) return 0;
  if (CFGetTypeID(value) != CFBooleanGetTypeID()) return 0;
  *out = CFBooleanGetValue((CFBooleanRef)value) ? 1 : 0;
  return 1;
}

int main(int argc, char **argv) {
  /* Nothing this helper does may block indefinitely. */
  alarm(WATCHDOG_SECONDS);

  if (argc != 2) return refuse("error");

  const char *requested = argv[1];
  size_t length = strnlen(requested, PATH_MAX);
  if (length == 0 || length >= PATH_MAX) return refuse("error");

  char resolved[PATH_MAX];
  if (realpath(requested, resolved) == NULL) return refuse("denied");

  struct stat target;
  if (stat(resolved, &target) != 0) return refuse("denied");
  if (!S_ISDIR(target.st_mode)) return refuse("error");

  /* Mirror libuv's widening so the caller's `st_dev` compares byte for byte. */
  char dev[32];
  if (snprintf(dev, sizeof(dev), "%llu",
               (unsigned long long)(long long)target.st_dev) <= 0) {
    return refuse("error");
  }

  struct statfs mounted;
  if (statfs(resolved, &mounted) != 0) return refuse("denied");
  if (mounted.f_mntonname[0] == '\0') return refuse("error");

  DASessionRef session = DASessionCreate(kCFAllocatorDefault);
  if (session == NULL) return refuse("unsupported");

  CFURLRef volume = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, (const UInt8 *)mounted.f_mntonname,
      (CFIndex)strnlen(mounted.f_mntonname, sizeof(mounted.f_mntonname)), TRUE);
  if (volume == NULL) {
    CFRelease(session);
    return refuse("error");
  }

  DADiskRef disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, volume);
  CFRelease(volume);
  if (disk == NULL) {
    CFRelease(session);
    return refuse("denied");
  }

  CFDictionaryRef description = DADiskCopyDescription(disk);
  if (description == NULL) {
    CFRelease(disk);
    CFRelease(session);
    /* Ordinary permissions did not yield a description. Do not escalate. */
    return refuse("denied");
  }

  int internal = 0, removable = 0, network = 0;
  int have_internal = boolean_key(description, kDADiskDescriptionDeviceInternalKey, &internal);
  int have_removable = boolean_key(description, kDADiskDescriptionMediaRemovableKey, &removable);
  int have_network = boolean_key(description, kDADiskDescriptionVolumeNetworkKey, &network);

  CFRelease(description);
  CFRelease(disk);
  CFRelease(session);

  char internal_out[2] = {'u', '\0'};
  char removable_out[2] = {'u', '\0'};
  if (have_internal) internal_out[0] = internal ? '1' : '0';
  if (have_removable) removable_out[0] = removable ? '1' : '0';

  /* A network volume is network regardless of what the media keys say. */
  if (have_network && network) {
    return emit("ok", "network", dev, internal_out, removable_out);
  }
  if (have_removable && removable) {
    return emit("ok", "removable", dev, internal_out, removable_out);
  }
  /*
   * local-fixed requires ALL THREE documented keys to be present and to agree:
   * internal, not removable, not network. Any absent key leaves the volume
   * undescribed in a way that matters, and an undescribed volume is unknown.
   */
  if (have_internal && have_removable && have_network && internal && !removable && !network) {
    return emit("ok", "local-fixed", dev, internal_out, removable_out);
  }
  return emit("ok", "unknown", dev, internal_out, removable_out);
}
