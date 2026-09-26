/* xgrab: capture one X11 window to PPM. Usage: xgrab <0xWINDOWID|root> <out.ppm> */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>

static int seen_error;
static int on_error(Display *d, XErrorEvent *e) {
    (void)d;
    fprintf(stderr, "X error opcode %d\n", e->error_code);
    seen_error = 1;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 3) { fprintf(stderr, "usage: xgrab <winid|root> <out.ppm>\n"); return 2; }
    Display *d = XOpenDisplay(NULL);
    if (!d) { fprintf(stderr, "cannot open display\n"); return 1; }
    Window w;
    if (strcmp(argv[1], "root") == 0) w = DefaultRootWindow(d);
    else w = (Window)strtoull(argv[1], NULL, 0);

    XWindowAttributes attr;
    if (!XGetWindowAttributes(d, w, &attr)) { fprintf(stderr, "bad window\n"); return 1; }
    int width = attr.width, height = attr.height;
    if (width <= 0 || height <= 0) { fprintf(stderr, "zero-size window\n"); return 1; }

    XSetErrorHandler(on_error);
    XSync(d, False);
    seen_error = 0;
    XImage *img = XGetImage(d, w, 0, 0, width, height, AllPlanes, ZPixmap);
    XSync(d, False);
    if (!img || seen_error) { fprintf(stderr, "capture failed\n"); return 1; }

    FILE *f = fopen(argv[2], "wb");
    fprintf(f, "P6\n%d %d\n255\n", width, height);
    unsigned char *row = malloc((size_t)width * 3);
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            unsigned long p = XGetPixel(img, x, y);
            row[x * 3 + 0] = (p >> 16) & 0xff;
            row[x * 3 + 1] = (p >> 8) & 0xff;
            row[x * 3 + 2] = p & 0xff;
        }
        fwrite(row, 3, width, f);
    }
    free(row);
    fclose(f);
    fprintf(stderr, "captured %dx%d -> %s\n", width, height, argv[2]);
    return 0;
}
