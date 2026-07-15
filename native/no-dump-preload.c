#define _GNU_SOURCE

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

static void fail_closed(const char *message, size_t size) {
  ssize_t ignored = write(STDERR_FILENO, message, size);
  (void)ignored;
  _exit(70);
}

__attribute__((constructor)) static void kassinao_disable_core_dumps(void) {
  static const char limit_error[] = "libkassinao-no-dump: RLIMIT_CORE failed\n";
  static const char filter_error[] = "libkassinao-no-dump: coredump_filter failed\n";
  static const char prctl_error[] = "libkassinao-no-dump: PR_SET_DUMPABLE failed\n";
  static const char marker_error[] = "libkassinao-no-dump: attestation failed\n";
  const struct rlimit no_core = {.rlim_cur = 0, .rlim_max = 0};
  char filter[32];
  char attestation[64];
  int saw_zero = 0;

  if (setrlimit(RLIMIT_CORE, &no_core) != 0) {
    fail_closed(limit_error, sizeof(limit_error) - 1);
  }
  int descriptor = open("/proc/self/coredump_filter", O_WRONLY | O_CLOEXEC);
  if (descriptor < 0 || write(descriptor, "0\n", 2) != 2 || close(descriptor) != 0) {
    if (descriptor >= 0) {
      (void)close(descriptor);
    }
    fail_closed(filter_error, sizeof(filter_error) - 1);
  }
  descriptor = open("/proc/self/coredump_filter", O_RDONLY | O_CLOEXEC);
  ssize_t size = descriptor < 0 ? -1 : read(descriptor, filter, sizeof(filter) - 1);
  if (descriptor >= 0) {
    (void)close(descriptor);
  }
  if (size <= 0) {
    fail_closed(filter_error, sizeof(filter_error) - 1);
  }
  for (ssize_t index = 0; index < size; index++) {
    char value = filter[index];
    if (value == '0') {
      saw_zero = 1;
    } else if (value != ' ' && value != '\t' && value != '\n' && value != '\r') {
      fail_closed(filter_error, sizeof(filter_error) - 1);
    }
  }
  if (!saw_zero) {
    fail_closed(filter_error, sizeof(filter_error) - 1);
  }
  if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
      prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
    fail_closed(prctl_error, sizeof(prctl_error) - 1);
  }
  int attestation_size = snprintf(attestation, sizeof(attestation), "prctl-v1:%ld", (long)getpid());
  if (attestation_size <= 0 || attestation_size >= (int)sizeof(attestation) ||
      setenv("KASSINAO_NO_DUMP_ACTIVE", attestation, 1) != 0) {
    fail_closed(marker_error, sizeof(marker_error) - 1);
  }
}
