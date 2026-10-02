use crate::probe::ProbeError;

fn unavailable(error: impl std::fmt::Display) -> ProbeError {
    ProbeError::new(
        "window_state_unavailable",
        format!("Could not read the window manager's always-on-top state: {error}"),
    )
}

pub fn is_always_on_top(window: tauri::Window) -> Result<bool, ProbeError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let queried = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(read(&queried));
        })
        .map_err(unavailable)?;
    receiver.recv().map_err(unavailable)?
}

fn read(window: &tauri::Window) -> Result<bool, ProbeError> {
    #[cfg(target_os = "linux")]
    if let Some(value) = x11::read(window)? {
        return Ok(value);
    }
    window.is_always_on_top().map_err(unavailable)
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::{unavailable, ProbeError};
    use ::x11::xlib;
    use gdkx11::glib::translate::ToGlibPtr;
    use gtk::prelude::*;
    use std::ptr;

    const MAX_STATE_ATOMS: usize = 64;

    struct PropertyData(*mut libc::c_uchar);

    impl Drop for PropertyData {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { xlib::XFree(self.0.cast()) };
            }
        }
    }

    fn validate_property(
        kind: xlib::Atom,
        format: libc::c_int,
        count: libc::c_ulong,
        remaining: libc::c_ulong,
    ) -> Result<(), ProbeError> {
        if remaining != 0 || count > MAX_STATE_ATOMS as libc::c_ulong {
            return Err(unavailable("the X11 window state was truncated"));
        }
        if kind == 0 && format == 0 && count == 0 {
            return Ok(());
        }
        if kind != xlib::XA_ATOM || format != 32 {
            return Err(unavailable("the X11 window state has an unexpected type"));
        }
        Ok(())
    }

    pub(super) fn read(window: &tauri::Window) -> Result<Option<bool>, ProbeError> {
        let gtk_window = window.gtk_window().map_err(unavailable)?;
        let native = gtk_window
            .window()
            .ok_or_else(|| unavailable("the native window is not ready"))?;
        let Ok(display) = native.display().downcast::<gdkx11::X11Display>() else {
            return Ok(None);
        };
        let native = native
            .downcast::<gdkx11::X11Window>()
            .map_err(|_| unavailable("the native window does not belong to X11"))?;
        let connection =
            unsafe { gdkx11::ffi::gdk_x11_display_get_xdisplay(display.to_glib_none().0) };
        if connection.is_null() {
            return Err(unavailable("the X11 display is unavailable"));
        }
        let state_atom =
            unsafe { xlib::XInternAtom(connection, c"_NET_WM_STATE".as_ptr(), xlib::True) };
        let above_atom =
            unsafe { xlib::XInternAtom(connection, c"_NET_WM_STATE_ABOVE".as_ptr(), xlib::True) };
        if state_atom == 0 || above_atom == 0 {
            return Ok(Some(false));
        }
        let mut kind = 0;
        let mut format = 0;
        let mut count = 0;
        let mut remaining = 0;
        let mut data = PropertyData(ptr::null_mut());
        display.error_trap_push();
        let status = unsafe {
            xlib::XGetWindowProperty(
                connection,
                native.xid(),
                state_atom,
                0,
                MAX_STATE_ATOMS as libc::c_long,
                xlib::False,
                xlib::AnyPropertyType as xlib::Atom,
                &mut kind,
                &mut format,
                &mut count,
                &mut remaining,
                &mut data.0,
            )
        };
        let error = display.error_trap_pop();
        if status != xlib::Success as libc::c_int || error != 0 {
            return Err(unavailable("the X11 window state request failed"));
        }
        validate_property(kind, format, count, remaining)?;
        if count == 0 {
            return Ok(Some(false));
        }
        if data.0.is_null() {
            return Err(unavailable("the X11 window state data is missing"));
        }
        let states =
            unsafe { std::slice::from_raw_parts(data.0.cast::<xlib::Atom>(), count as usize) };
        Ok(Some(states.contains(&above_atom)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_complete_native_atom_list_is_readable() {
            assert!(validate_property(xlib::XA_ATOM, 32, 3, 0).is_ok());
            assert!(validate_property(xlib::XA_ATOM, 32, 0, 0).is_ok());
        }

        #[test]
        fn an_absent_property_has_no_window_states() {
            assert!(validate_property(0, 0, 0, 0).is_ok());
            assert!(validate_property(0, 32, 1, 0).is_err());
        }

        #[test]
        fn a_different_property_type_or_format_is_not_an_unpin() {
            assert!(validate_property(xlib::XA_CARDINAL, 32, 1, 0).is_err());
            assert!(validate_property(xlib::XA_ATOM, 8, 1, 0).is_err());
            assert!(validate_property(xlib::XA_ATOM, 16, 1, 0).is_err());
        }

        #[test]
        fn incomplete_or_oversized_properties_are_not_an_unpin() {
            assert!(validate_property(xlib::XA_ATOM, 32, 64, 4).is_err());
            assert!(validate_property(xlib::XA_ATOM, 32, 65, 0).is_err());
        }
    }
}
