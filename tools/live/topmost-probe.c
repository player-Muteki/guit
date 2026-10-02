#define _GNU_SOURCE
#include <dlfcn.h>
#include <gdk/gdkx.h>
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <X11/Xatom.h>

static int x11_above(GdkWindow *window) {
    if (!window || gdk_window_is_destroyed(window)) return -1;
    GdkDisplay *display = gdk_window_get_display(window);
    if (!GDK_IS_X11_DISPLAY(display)) return -1;
    Display *connection = gdk_x11_display_get_xdisplay(display);
    Atom state_atom = XInternAtom(connection, "_NET_WM_STATE", True);
    Atom above_atom = XInternAtom(connection, "_NET_WM_STATE_ABOVE", True);
    if (state_atom == None || above_atom == None) return -1;
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long count = 0;
    unsigned long remaining = 0;
    unsigned char *data = NULL;
    gdk_x11_display_error_trap_push(display);
    int status = XGetWindowProperty(connection, gdk_x11_window_get_xid(window),
                                   state_atom, 0, 64, False, XA_ATOM,
                                   &actual_type, &actual_format, &count, &remaining, &data);
    int error = gdk_x11_display_error_trap_pop(display);
    int above = -1;
    if (!error && status == Success && !remaining) {
        if (actual_type == None) above = 0;
        else if (actual_type == XA_ATOM && actual_format == 32) {
            above = 0;
            Atom *states = (Atom *)data;
            for (unsigned long index = 0; index < count; index++) {
                if (states[index] == above_atom) above = 1;
            }
        }
    }
    if (data) XFree(data);
    return above;
}

static void report(GtkWidget *widget, const char *event) {
    GdkDisplay *display = gtk_widget_get_display(widget);
    GdkWindow *window = gtk_widget_get_window(widget);
    GdkWindowState state = window ? gdk_window_get_state(window) : 0;
    fprintf(stderr,
            "[guit-topmost] at_ms=%" G_GINT64_FORMAT " event=%s widget=%s backend=%s visible=%d mapped=%d realized=%d "
            "gdk_above=%d x11_above=%d maximized=%d fullscreen=%d minimized=%d\n",
            g_get_monotonic_time() / 1000, event, G_OBJECT_TYPE_NAME(widget),
            display ? G_OBJECT_TYPE_NAME(display) : "none",
            gtk_widget_get_visible(widget), gtk_widget_get_mapped(widget),
            gtk_widget_get_realized(widget), window ? !!(state & GDK_WINDOW_STATE_ABOVE) : -1,
            x11_above(window), !!(state & GDK_WINDOW_STATE_MAXIMIZED),
            !!(state & GDK_WINDOW_STATE_FULLSCREEN), !!(state & GDK_WINDOW_STATE_ICONIFIED));
    fflush(stderr);
}

static gboolean changed(GtkWidget *widget, GdkEvent *event, gpointer label) {
    (void)event;
    report(widget, (const char *)label);
    return FALSE;
}

static gboolean delayed(gpointer widget) {
    report(GTK_WIDGET(widget), "after-1500ms");
    return G_SOURCE_REMOVE;
}

gboolean gtk_init_check(int *argument_count, char ***arguments) {
    gboolean (*next)(int *, char ***) = dlsym(RTLD_NEXT, "gtk_init_check");
    if (!next) {
        fprintf(stderr, "[guit-topmost] error=missing-gtk-init\n");
        return FALSE;
    }
    gboolean ready = next(argument_count, arguments);
    GdkDisplay *display = gdk_display_get_default();
    fprintf(stderr, "[guit-topmost] event=init ready=%d backend=%s\n", ready,
            display ? G_OBJECT_TYPE_NAME(display) : "none");
    fflush(stderr);
    return ready;
}

void gtk_window_set_keep_above(GtkWindow *window, gboolean setting) {
    void (*next)(GtkWindow *, gboolean) = dlsym(RTLD_NEXT, "gtk_window_set_keep_above");
    if (!next) {
        fprintf(stderr, "[guit-topmost] error=missing-keep-above\n");
        abort();
    }
    if (!g_object_get_data(G_OBJECT(window), "guit-topmost-probe")) {
        g_object_set_data(G_OBJECT(window), "guit-topmost-probe", GINT_TO_POINTER(1));
        g_signal_connect(window, "window-state-event", G_CALLBACK(changed), "state-change");
        g_signal_connect(window, "map-event", G_CALLBACK(changed), "mapped");
        g_signal_connect(window, "focus-in-event", G_CALLBACK(changed), "focus-in");
        g_signal_connect(window, "focus-out-event", G_CALLBACK(changed), "focus-out");
    }
    next(window, setting);
    report(GTK_WIDGET(window), setting ? "request-on" : "request-off");
    g_timeout_add_full(G_PRIORITY_DEFAULT, 1500, delayed, g_object_ref(window), g_object_unref);
}
