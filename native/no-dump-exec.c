#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * Process-scoped core guard used as the published container entrypoint.
 *
 * RLIMIT_CORE and coredump_filter survive execve(2). PR_SET_DUMPABLE does
 * not: Linux resets it while loading a normal executable. Dynamic targets
 * therefore use libkassinao-no-dump.so, whose constructor re-applies
 * PR_SET_DUMPABLE=0 after the final exec and before main(). A static target
 * still receives coredump_filter=0 and a hard core limit of zero.
 */

static int core_limits_are_zero(void) {
  struct rlimit core_limit;
  return getrlimit(RLIMIT_CORE, &core_limit) == 0 && core_limit.rlim_cur == 0 &&
         core_limit.rlim_max == 0;
}

static int coredump_filter_is_zero(void) {
  char buffer[32];
  char *cursor;
  char *end;
  int descriptor = open("/proc/self/coredump_filter", O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    return 0;
  }
  ssize_t size = read(descriptor, buffer, sizeof(buffer) - 1);
  int saved_errno = errno;
  close(descriptor);
  errno = saved_errno;
  if (size <= 0 || size >= (ssize_t)sizeof(buffer)) {
    return 0;
  }
  buffer[size] = '\0';
  errno = 0;
  unsigned long value = strtoul(buffer, &end, 16);
  if (errno != 0 || end == buffer || value != 0) {
    return 0;
  }
  for (cursor = end; *cursor != '\0'; cursor++) {
    if (*cursor != ' ' && *cursor != '\t' && *cursor != '\n' && *cursor != '\r') {
      return 0;
    }
  }
  return 1;
}

static int set_coredump_filter_zero(void) {
  int descriptor = open("/proc/self/coredump_filter", O_WRONLY | O_CLOEXEC);
  if (descriptor < 0) {
    return -1;
  }
  ssize_t size = write(descriptor, "0\n", 2);
  int saved_errno = errno;
  close(descriptor);
  errno = saved_errno;
  return size == 2 && coredump_filter_is_zero() ? 0 : -1;
}

static int preserved_guard_is_active(void) {
  return core_limits_are_zero() && coredump_filter_is_zero();
}

static int current_process_is_non_dumpable(void) {
  return preserved_guard_is_active() && prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) == 0;
}

static int activate_guard(void) {
  const struct rlimit no_core = {.rlim_cur = 0, .rlim_max = 0};

  if (setrlimit(RLIMIT_CORE, &no_core) != 0) {
    fprintf(stderr, "kassinao-no-dump: setrlimit(RLIMIT_CORE) failed: %s\n", strerror(errno));
    return -1;
  }
  if (set_coredump_filter_zero() != 0) {
    fprintf(stderr, "kassinao-no-dump: coredump_filter=0 failed: %s\n", strerror(errno));
    return -1;
  }
  if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
    fprintf(stderr, "kassinao-no-dump: prctl(PR_SET_DUMPABLE) failed: %s\n", strerror(errno));
    return -1;
  }
  if (!current_process_is_non_dumpable()) {
    fputs("kassinao-no-dump: process guard did not become active\n", stderr);
    return -1;
  }
  return 0;
}

static int seal_loader_environment(const char *preload) {
  static const char *const loader_variables[] = {
      "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "LD_DEBUG", "LD_PROFILE", "LD_ORIGIN_PATH"};
  size_t index;

  for (index = 0; index < sizeof(loader_variables) / sizeof(loader_variables[0]); index++) {
    if (unsetenv(loader_variables[index]) != 0) {
      return -1;
    }
  }
  if (preload != NULL && setenv("LD_PRELOAD", preload, 1) != 0) {
    return -1;
  }
  return 0;
}

static int safe_preload(const char *path) {
  struct stat metadata;
  char resolved[PATH_MAX];
  char directory[PATH_MAX];
  char *separator;
  uid_t effective_uid = geteuid();

  if (path == NULL || path[0] != '/' || realpath(path, resolved) == NULL || strcmp(path, resolved) != 0 ||
      lstat(path, &metadata) != 0) {
    return 0;
  }
  if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1 || (metadata.st_mode & 0022) != 0) {
    return 0;
  }
  if (metadata.st_uid != 0 && metadata.st_uid != effective_uid) {
    return 0;
  }

  if (strlen(resolved) >= sizeof(directory)) {
    return 0;
  }
  strcpy(directory, resolved);
  separator = strrchr(directory, '/');
  if (separator == NULL) {
    return 0;
  }
  if (separator == directory) {
    directory[1] = '\0';
  } else {
    *separator = '\0';
  }
  for (;;) {
    if (lstat(directory, &metadata) != 0 || !S_ISDIR(metadata.st_mode) ||
        (metadata.st_uid != 0 && metadata.st_uid != effective_uid) || (metadata.st_mode & 0022) != 0) {
      return 0;
    }
    if ((metadata.st_mode & 0077) == 0 || strcmp(directory, "/") == 0) {
      return 1;
    }
    separator = strrchr(directory, '/');
    if (separator == NULL) {
      return 0;
    }
    if (separator == directory) {
      directory[1] = '\0';
    } else {
      *separator = '\0';
    }
  }
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--check-preserved") == 0) {
    return preserved_guard_is_active() ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--check-current") == 0) {
    return current_process_is_non_dumpable() ? 0 : 1;
  }

  int cursor = 1;
  const char *preload = NULL;
  if (argc > cursor + 1 && strcmp(argv[cursor], "--preload") == 0) {
    preload = argv[cursor + 1];
    cursor += 2;
  }
  if (argc > cursor && strcmp(argv[cursor], "--") == 0) {
    cursor++;
  }
  if (cursor >= argc) {
    fputs("usage: kassinao-no-dump [--preload ABSOLUTE_SO] [--] PROGRAM [ARG ...]\n", stderr);
    return 64;
  }
  if (preload != NULL && !safe_preload(preload)) {
    fputs("kassinao-no-dump: preload must be a protected regular file\n", stderr);
    return 65;
  }
  if (activate_guard() != 0) {
    return 70;
  }

  if (unsetenv("KASSINAO_NO_DUMP_ACTIVE") != 0 || seal_loader_environment(preload) != 0) {
    fputs("kassinao-no-dump: failed to seal preload environment\n", stderr);
    return 70;
  }
  execvp(argv[cursor], &argv[cursor]);
  fprintf(stderr, "kassinao-no-dump: exec failed: %s\n", strerror(errno));
  return errno == ENOENT ? 127 : 126;
}
