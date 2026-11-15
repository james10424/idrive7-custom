/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
#include "guard.h"

#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <sstream>

namespace l2r {

namespace {

std::string read_word(const std::string &path)
{
    std::ifstream f(path);
    std::string w;
    f >> w;
    return w;
}

bool write_text(const std::string &path, const std::string &text)
{
    const std::string tmp = path + ".tmp";
    FILE *f = fopen(tmp.c_str(), "w");
    if (!f) return false;
    bool ok = fputs(text.c_str(), f) >= 0;
    ok = fflush(f) == 0 && fsync(fileno(f)) == 0 && ok;   /* on disk before a crash can take the unit down */
    fclose(f);
    return ok && rename(tmp.c_str(), path.c_str()) == 0;
}

}  // namespace

Guard::Guard(const std::string &dir, const std::string &boot_id) : dir_(dir), boot_(boot_id)
{
    if (boot_.empty()) boot_ = read_word("/proc/sys/kernel/random/boot_id");
    if (boot_.empty()) boot_ = "unknown";
}

void Guard::start()
{
    mkdir(dir_.c_str(), 0755);
    refusal_.clear();
    const std::string was = read_word(path("drawing"));
    std::string crash_boot;
    int crashes = 0;
    {
        std::ifstream f(path("crashes"));
        f >> crash_boot >> crashes;
        if (crash_boot != boot_) crashes = 0;
    }
    if (!was.empty() && was != boot_) {
        refusal_ = "the head unit restarted while live2d-render was drawing; it draws nothing until " + path("drawing") +
                   " is removed";
        return;   /* the file stays: removing it is the owner's call */
    }
    if (!was.empty()) {
        crashes++;
        std::ostringstream o;
        o << boot_ << " " << crashes << "\n";
        write_text(path("crashes"), o.str());
        unlink(path("drawing").c_str());
        fprintf(stderr, "live2d-render: the last run ended while drawing (%d this boot)\n", crashes);
    }
    if (crashes >= kMaxCrashes) {
        std::ostringstream o;
        o << "live2d-render ended while drawing " << crashes << " times since the head unit started; it draws "
          << "nothing until the next start";
        refusal_ = o.str();
    }
}

void Guard::begin()
{
    if (drawing_) return;
    drawing_ = true;
    if (!write_text(path("drawing"), boot_ + "\n"))
        fprintf(stderr, "live2d-render: cannot write %s\n", path("drawing").c_str());
}

void Guard::end()
{
    if (!drawing_) return;
    drawing_ = false;
    unlink(path("drawing").c_str());
}

}  // namespace l2r
