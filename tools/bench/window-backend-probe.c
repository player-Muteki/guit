#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int gtk_init_check(int *argument_count, char ***arguments) {
    (void)argument_count;
    (void)arguments;
    const char *backend = getenv("GDK_BACKEND");
    printf("GDK_BACKEND at GTK initialization: %s\n", backend ? backend : "unset");
    fflush(stdout);
    _Exit(backend && strcmp(backend, "x11,wayland") == 0 ? 0 : 1);
}
