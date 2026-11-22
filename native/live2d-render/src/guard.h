/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* The crash guard. live2d-render is the one process here that drives the GPU
 * itself, and a GPU fault in it once restarted the whole head unit. So while
 * it draws it keeps a file, <dir>/drawing, holding the boot's id, and removes
 * it when it stops drawing (a model closed, hidden, or the display gone: a car
 * switching off takes the KOMBI first, so a normal power-off leaves no file):
 *   - found from an earlier boot: the head unit went down while it drew. It
 *     draws nothing again until the file is removed by hand (README.md
 *     "If the head unit restarted").
 *   - found from this boot: live2d-render itself ended while drawing (a
 *     crash). After kMaxCrashes in one boot it refuses for the rest of it. */
#ifndef LIVE2D_RENDER_GUARD_H
#define LIVE2D_RENDER_GUARD_H

#include <string>

namespace l2r {

class Guard {
public:
    static const int kMaxCrashes = 3;
    /* boot_id: this boot's (/proc/sys/kernel/random/boot_id); empty reads it. */
    explicit Guard(const std::string &dir, const std::string &boot_id = "");
    /* Once at start: looks at what the last run left. */
    void start();
    /* "" when drawing may start, else why not. A refusal over an earlier boot's
     * file lifts once the file is gone (looked at again each call). */
    const std::string &refusal();
    /* The owner's reset (an app's "restart"): the drawing file and this boot's
     * crash count go, and with them any refusal. */
    void reset();
    void begin();   /* drawing starts */
    void end();     /* it stops cleanly */

private:
    std::string dir_, boot_, refusal_;
    bool drawing_ = false;
    bool old_boot_ = false;   /* refusal_ is over an earlier boot's file */
    std::string path(const char *name) const { return dir_ + "/" + name; }
};

}  // namespace l2r

#endif
