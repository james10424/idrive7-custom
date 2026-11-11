// A mechanical odometer for a cluster-render "effect" layer (GLSL ES 1.00): u_odo.x drums side by side, each a digit
// of the R8 glyph atlas bound to u_font (u_grid.x columns by u_grid.y rows of cells; u_dig the cells of 0..9) rolling
// upward as its position (u_drum, 0..10, most significant first) grows, shaded as a cylinder. The app works out the
// positions and the carries (hud.js "odo"); a new position is one small uniform message. One texture read a pixel.
// v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_font;
uniform vec2 u_grid;      // atlas columns, rows
uniform vec4 u_dig[3];    // atlas cells of 0..9 (10 of 12)
uniform vec4 u_drum[2];   // the drums' positions, the leftmost first (up to 8)
uniform vec4 u_color;     // the digits
uniform vec2 u_size;      // the layer, px
uniform vec4 u_odo;       // drums, gap between drums px, on (0: no reading, blank drums), frame px

float pick4(vec4 v, float i) { return i < 0.5 ? v.x : i < 1.5 ? v.y : i < 2.5 ? v.z : v.w; }

void main() {
    vec2 p = v_uv * u_size;
    float n = u_odo.x, pitch = u_size.x / n;
    float cell = min(floor(p.x / pitch), n - 1.0), lx = p.x - cell * pitch;
    float g = u_odo.y * 0.5;
    // the frame round the drums and the gaps between them: a dim grey, the drums black
    float fr = u_odo.w;
    bool frame = p.x < fr || p.y < fr || p.x > u_size.x - fr || p.y > u_size.y - fr || lx < g || lx > pitch - g;
    if (frame) { gl_FragColor = vec4(0.22, 0.22, 0.24, 1.0); return; }
    if (u_odo.z < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float pos = cell < 3.5 ? pick4(u_drum[0], cell) : pick4(u_drum[1], cell - 4.0);
    float vy = (p.y - fr) / (u_size.y - 2.0 * fr);
    float s = pos + vy, d = mod(floor(s), 10.0), gy = fract(s);
    float code = d < 3.5 ? pick4(u_dig[0], d) : d < 7.5 ? pick4(u_dig[1], d - 4.0) : pick4(u_dig[2], d - 8.0);
    float gx = (lx - g) / (pitch - 2.0 * g);
    float col = mod(code, u_grid.x), row = floor(code / u_grid.x);
    float ink = texture2D(u_font, vec2((col + gx) / u_grid.x, (row + gy) / u_grid.y)).r;
    // the drum's curve: brightest at the window's middle, darker toward its top and bottom edges
    float shade = 0.45 + 0.55 * sin(3.14159 * clamp(vy, 0.0, 1.0));
    gl_FragColor = vec4(u_color.rgb * ink * shade, 1.0);
}
