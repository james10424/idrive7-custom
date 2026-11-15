/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* The crash guard: a clean run, a crash, too many crashes, and the head unit going down while drawing. */
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "guard.h"

static int failed = 0;
#define CHECK(c)                                                         \
    do {                                                                 \
        if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); failed++; } \
    } while (0)

static bool exists(const std::string &p) { return access(p.c_str(), F_OK) == 0; }

int main(int argc, char **argv)
{
    using l2r::Guard;
    const std::string dir = std::string(argc > 1 ? argv[1] : "/tmp") + "/guard_test_state";
    std::string rm = "rm -rf '" + dir + "'";
    if (system(rm.c_str()) != 0) return 1;

    { Guard g(dir, "boot-a"); g.start(); CHECK(g.refusal().empty()); g.begin(); CHECK(exists(dir + "/drawing")); g.end();
      CHECK(!exists(dir + "/drawing")); }
    /* crashes in this boot: the first two are let through, the third refused */
    for (int i = 1; i <= Guard::kMaxCrashes; i++) {
        Guard g(dir, "boot-a");
        g.start();
        if (i == 1) CHECK(g.refusal().empty());
        else CHECK(g.refusal().empty() == (i - 1 < Guard::kMaxCrashes));
        g.begin();   /* and "crashes": no end() */
    }
    { Guard g(dir, "boot-a"); g.start(); CHECK(!g.refusal().empty()); CHECK(g.refusal().find("times") != std::string::npos); }
    /* a new boot clears the count */
    { Guard g(dir, "boot-b"); g.start(); CHECK(g.refusal().empty()); g.begin(); }
    /* boot-b's drawing file seen from boot-c: the unit went down while drawing; refused until removed */
    { Guard g(dir, "boot-c"); g.start(); CHECK(g.refusal().find("restarted") != std::string::npos); CHECK(exists(dir + "/drawing")); }
    { Guard g(dir, "boot-c"); g.start(); CHECK(!g.refusal().empty()); }
    unlink((dir + "/drawing").c_str());
    { Guard g(dir, "boot-c"); g.start(); CHECK(g.refusal().empty()); }

    if (system(rm.c_str()) != 0) return 1;
    if (failed) { fprintf(stderr, "guard_test: %d failed\n", failed); return 1; }
    printf("guard_test: ok\n");
    return 0;
}
