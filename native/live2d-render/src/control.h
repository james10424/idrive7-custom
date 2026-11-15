/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* live2d-render's control messages (README.md "Protocol"): one flat JSON
 * object a line each way, over its socket. */
#ifndef LIVE2D_RENDER_CONTROL_H
#define LIVE2D_RENDER_CONTROL_H

#include <map>
#include <string>
#include <vector>

#include "cluster_render/protocol.h"

namespace l2r {

/* "open": a model, where its picture goes, and how it is framed. */
struct OpenRequest {
    std::string model;            /* <model>.model3.json, an absolute path */
    unsigned w = 0, h = 0;        /* the picture (w a multiple of 4, h even) */
    unsigned fps = 15;
    unsigned masks = 2;           /* clipping-mask textures (one holds 36 masks) */
    std::string target = "hud";   /* cluster-render's */
    int x = 0, y = 0, z = 0;
    std::string klass = "content";
    float cx = 0, cy = 0, height = 2;   /* frame: the model-unit box (centre, height) that fills the picture */
    std::vector<std::string> hide;      /* part ids drawn transparent */
    bool visible = true;
};

/* Fills *out from an open message; false and *err when a field is wrong. */
bool parse_open(const cr::Json &m, OpenRequest *out, std::string *err);

/* The model's parameters, by id, and their values now. */
class Params {
public:
    void reset(const std::vector<std::string> &ids, const std::vector<float> &defaults);
    /* "Id=value Id=value ..." (space or comma separated): sets each; ids the
     * model hasn't go into *unknown once each. Returns how many it set, or -1
     * for a malformed list. */
    int apply(const std::string &list, std::vector<std::string> *unknown);
    void to_defaults() { values_ = defaults_; }
    const std::vector<float> &values() const { return values_; }
    int index(const std::string &id) const;

private:
    std::map<std::string, int> index_;
    std::vector<float> values_, defaults_;
    std::map<std::string, bool> reported_;
};

/* The column-major model-view-projection that puts the box (cx, cy, height),
 * the picture's aspect, over the whole w x h picture. */
void frame_mvp(float cx, float cy, float height, unsigned w, unsigned h, float out[16]);
/* in, its picture moved ox px right and oy px down (fractions of a pixel too: "offset", the app's bounce). */
void offset_mvp(const float in[16], float ox, float oy, unsigned w, unsigned h, float out[16]);

std::vector<std::string> split_list(const std::string &s);

/* From cluster-render's status text ("dcsm: Dcsm2 available for 12 s"): how
 * many seconds the KOMBI's display service has been up; -1 not available (or
 * not yet), -2 no display service line at all (not a car: a bench). */
int display_up_s(const std::string &status_text);

}  // namespace l2r

#endif
