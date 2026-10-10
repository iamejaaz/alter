#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
fn own_privacy_prompts() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        fn responsibility_spawnattrs_setdisclaim(attr: *mut libc::posix_spawnattr_t, disclaim: libc::c_int) -> libc::c_int;
    }
    if std::env::var_os("ALTER_OWN_TCC").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if exe.to_string_lossy().contains(".app/Contents/MacOS/") {
        return;
    }
    std::env::set_var("ALTER_OWN_TCC", "1");
    let Ok(path) = CString::new(exe.as_os_str().as_bytes()) else { return };
    let args: Vec<CString> = std::env::args_os().filter_map(|a| CString::new(a.as_bytes()).ok()).collect();
    let envs: Vec<CString> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let mut kv = k.as_bytes().to_vec();
            kv.push(b'=');
            kv.extend_from_slice(v.as_bytes());
            CString::new(kv).ok()
        })
        .collect();
    let mut argv: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());
    let mut envp: Vec<*mut libc::c_char> = envs.iter().map(|e| e.as_ptr() as *mut _).collect();
    envp.push(std::ptr::null_mut());
    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return;
        }
        libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETEXEC as libc::c_short);
        responsibility_spawnattrs_setdisclaim(&mut attr, 1);
        let mut pid: libc::pid_t = 0;
        libc::posix_spawn(&mut pid, path.as_ptr(), std::ptr::null(), &attr, argv.as_ptr(), envp.as_ptr());
        libc::posix_spawnattr_destroy(&mut attr);
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    own_privacy_prompts();
    alter_lib::run()
}
