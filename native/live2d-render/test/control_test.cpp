/* SPDX-License-Identifier: MIT
 * Copyright (C) 2026 James Zhao */
/* The control messages: open's fields and their limits, parameter lists, the frame's projection. */
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "control.h"

static int failed = 0;
#define CHECK(c)                                                         \
    do {                                                                 \
        if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); failed++; } \
    } while (0)

static cr::Json J(const char *s)
{
    cr::Json m;
    if (!cr::parse_json(s, &m)) { fprintf(stderr, "bad test JSON %s\n", s); exit(1); }
    return m;
}

int main()
{
    using namespace l2r;
    std::string err;
    OpenRequest o;
    CHECK(parse_open(J("{\"t\":\"open\",\"model\":\"/m/a.model3.json\",\"w\":248,\"h\":280,\"fps\":15,\"x\":356,"
                       "\"y\":100,\"z\":3,\"frame\":\"0 1.31 0.82\",\"hide\":\"Part49,Part50\",\"visible\":false}"),
                     &o, &err));
    CHECK(o.model == "/m/a.model3.json" && o.w == 248 && o.h == 280 && o.fps == 15 && o.x == 356 && o.y == 100 && o.z == 3);
    CHECK(std::fabs(o.cy - 1.31f) < 1e-6 && std::fabs(o.height - 0.82f) < 1e-6 && o.cx == 0);
    CHECK(o.hide.size() == 2 && o.hide[1] == "Part50" && !o.visible && o.target == "hud" && o.masks == 2);

    const char *bad[] = {
        "{\"model\":\"a.model3.json\",\"w\":248,\"h\":280,\"frame\":\"0 0 1\"}",   /* not absolute */
        "{\"model\":\"/a\",\"w\":250,\"h\":280,\"frame\":\"0 0 1\"}",              /* w not a multiple of 4 */
        "{\"model\":\"/a\",\"w\":248,\"h\":281,\"frame\":\"0 0 1\"}",              /* h odd */
        "{\"model\":\"/a\",\"w\":248,\"h\":280}",                                  /* no frame */
        "{\"model\":\"/a\",\"w\":248,\"h\":280,\"frame\":\"0 0\"}",                /* short frame */
        "{\"model\":\"/a\",\"w\":248,\"h\":280,\"frame\":\"0 0 0\"}",              /* zero height */
        "{\"model\":\"/a\",\"w\":248,\"h\":280,\"frame\":\"0 0 1\",\"fps\":60}",   /* fps */
        "{\"model\":\"/a\",\"w\":2000,\"h\":280,\"frame\":\"0 0 1\"}",             /* too wide */
    };
    for (const char *b : bad) {
        OpenRequest r;
        std::string e;
        CHECK(!parse_open(J(b), &r, &e) && !e.empty());
    }

    Params p;
    p.reset({"ParamAngleX", "ParamAngleY", "Blush"}, {0, 0, 0.5f});
    std::vector<std::string> unknown;
    CHECK(p.apply("ParamAngleX=12.5 Blush=1,Nope=3", &unknown) == 2);
    CHECK(p.values()[0] == 12.5f && p.values()[1] == 0 && p.values()[2] == 1);
    CHECK(unknown.size() == 1 && unknown[0] == "Nope");
    unknown.clear();
    CHECK(p.apply("Nope=4", &unknown) == 0 && unknown.empty());   /* reported once */
    CHECK(p.apply("ParamAngleX", &unknown) == -1);
    CHECK(p.apply("ParamAngleX=abc", &unknown) == -1);
    CHECK(p.apply("=3", &unknown) == -1);
    CHECK(p.apply("", &unknown) == 0);
    p.to_defaults();
    CHECK(p.values()[0] == 0 && p.values()[2] == 0.5f);

    /* the box's centre goes to the picture's centre, its top edge to the top */
    float m[16];
    frame_mvp(0, 1.31f, 0.82f, 248, 280, m);
    CHECK(std::fabs(m[5] * 1.31f + m[13]) < 1e-5);
    CHECK(std::fabs(m[5] * (1.31f + 0.41f) + m[13] - 1) < 1e-5);
    CHECK(std::fabs(m[0] / m[5] - 280.0f / 248.0f) < 1e-5);   /* square model units on the picture */

    if (failed) { fprintf(stderr, "control_test: %d failed\n", failed); return 1; }
    printf("control_test: ok\n");
    return 0;
}
