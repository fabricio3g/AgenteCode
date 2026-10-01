//! The Linux box: the `agente` binary, started as `agente __sandbox <plan> --
//! <program> [args…]`, locks itself down and then `exec`s the program, which
//! inherits every restriction:
//!
//! - **Landlock:** write only the project and its temp folder; read only the
//!   system's programs, libraries and configuration (never the user's home,
//!   so no keys, no `~/.agente`, no other bot); a few device files; no ptrace
//!   or signals to processes outside the box.
//! - **seccomp:** `socket()` is refused for every family when the network is
//!   off, and for all but IP and netlink when it's on. That also closes the
//!   Unix sockets Landlock doesn't cover (the session bus and its keyring,
//!   the Docker socket). `io_uring` is refused (it can open sockets too).
//! - **Limits:** largest file written, CPU time, no core dumps.
//!
//! Anything that can't be enforced stops the command: the box never runs a
//! program unboxed.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

use landlock::{
    path_beneath_rules, Access, AccessFs, BitFlags, CompatLevel, Compatible, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, Scope, ABI,
};
use serde::{Deserialize, Serialize};

use super::SandboxPolicy;

/// What the helper is told: the policy and the folders it applies to.
#[derive(Serialize, Deserialize)]
pub(super) struct Plan {
    pub policy: SandboxPolicy,
    pub project: PathBuf,
    pub tmp: PathBuf,
}

/// System folders a boxed program may read (and run programs from).
const SYSTEM_READ: &[&str] = &[
    "/bin",
    "/sbin",
    "/usr",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/etc",
    "/opt",
    "/proc",
    "/sys",
    "/nix/store",
];
/// Where the resolver's configuration lives (`/etc/resolv.conf` points here).
const RESOLVER_READ: &[&str] = &["/run/systemd/resolve"];
/// Device files a program may read and write; `/dev/shm` and the rest stay out.
const DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
];

/// Whether this kernel has Landlock (and this is an architecture the seccomp
/// filter knows).
pub(super) fn supported() -> bool {
    const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;
    if seccomp::AUDIT_ARCH.is_none() {
        return false;
    }
    // SAFETY: the version query takes no ruleset (null, size 0) and only
    // returns a number.
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    abi >= 1
}

pub(super) fn helper_main(args: &[String]) -> ! {
    match run(args) {
        Ok(never) => match never {},
        Err(message) => {
            eprintln!("agente sandbox: {message}");
            std::process::exit(126);
        }
    }
}

enum Never {}

fn run(args: &[String]) -> Result<Never, String> {
    let (plan, command) = match args {
        [plan, dashes, command @ ..] if dashes == "--" && !command.is_empty() => (plan, command),
        _ => return Err("usage: agente __sandbox <plan> -- <program> [args…]".into()),
    };
    let plan: Plan = serde_json::from_str(plan).map_err(|error| format!("bad plan: {error}"))?;

    limit(
        libc::RLIMIT_FSIZE,
        plan.policy.file_mb.saturating_mul(1024 * 1024),
    )?;
    limit(libc::RLIMIT_CPU, plan.policy.cpu_secs)?;
    limit(libc::RLIMIT_CORE, 0)?;
    restrict_files(&plan)?;
    seccomp::install(plan.policy.network)?;

    let error = std::process::Command::new(&command[0])
        .args(&command[1..])
        .exec();
    Err(format!("could not run {}: {error}", command[0]))
}

/// `setrlimit`'s resource type: glibc names it, musl uses a plain int.
#[cfg(target_env = "gnu")]
type Resource = libc::__rlimit_resource_t;
#[cfg(not(target_env = "gnu"))]
type Resource = libc::c_int;

/// Set a resource limit, never above the hard limit this process already has.
fn limit(resource: Resource, value: u64) -> Result<(), String> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a valid rlimit for the kernel to fill.
    if unsafe { libc::getrlimit(resource, &mut current) } != 0 {
        return Err(format!(
            "could not read a limit: {}",
            std::io::Error::last_os_error()
        ));
    }
    let value = (value as libc::rlim_t).min(current.rlim_max);
    let next = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: `next` is a valid rlimit no higher than the current hard limit.
    if unsafe { libc::setrlimit(resource, &next) } != 0 {
        return Err(format!(
            "could not set a limit: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Only paths that exist: Landlock rules are made from open files.
fn existing<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Vec<&'a Path> {
    paths.into_iter().filter(|path| path.exists()).collect()
}

fn restrict_files(plan: &Plan) -> Result<(), String> {
    let abi = ABI::V6;
    let read = AccessFs::from_read(abi);
    let all = AccessFs::from_all(abi);
    let device: BitFlags<AccessFs> = AccessFs::ReadFile | AccessFs::WriteFile;

    let mut readable: Vec<&Path> = SYSTEM_READ.iter().map(Path::new).collect();
    if plan.policy.network {
        readable.extend(RESOLVER_READ.iter().map(Path::new));
    }
    readable.extend(plan.policy.read.iter().map(PathBuf::as_path));
    let mut writable: Vec<&Path> = vec![plan.project.as_path(), plan.tmp.as_path()];
    writable.extend(plan.policy.write.iter().map(PathBuf::as_path));

    let fail = |error: landlock::RulesetError| format!("could not set up the box: {error}");
    let status = Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(all)
        .map_err(fail)?
        .scope(Scope::from_all(abi))
        .map_err(fail)?
        .create()
        .map_err(fail)?
        .add_rules(path_beneath_rules(existing(readable), read))
        .map_err(fail)?
        .add_rules(path_beneath_rules(existing(writable), all))
        .map_err(fail)?
        .add_rules(path_beneath_rules(
            existing(DEVICES.iter().map(Path::new)),
            device,
        ))
        .map_err(fail)?
        .restrict_self()
        .map_err(fail)?;
    match status.ruleset {
        RulesetStatus::FullyEnforced | RulesetStatus::PartiallyEnforced => Ok(()),
        RulesetStatus::NotEnforced => Err("this kernel doesn't enforce Landlock".into()),
    }
}

mod seccomp {
    //! A classic BPF filter, written out by hand (no seccomp library).

    #[cfg(target_arch = "x86_64")]
    pub(super) const AUDIT_ARCH: Option<u32> = Some(0xC000_003E);
    #[cfg(target_arch = "aarch64")]
    pub(super) const AUDIT_ARCH: Option<u32> = Some(0xC000_00B7);
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    pub(super) const AUDIT_ARCH: Option<u32> = None;

    const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    #[cfg(target_arch = "x86_64")]
    const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
    const RET_K: u16 = 0x06; // BPF_RET | BPF_K

    const RET_ALLOW: u32 = 0x7fff_0000;
    const RET_KILL_PROCESS: u32 = 0x8000_0000;
    const RET_EPERM: u32 = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;

    // `struct seccomp_data`: nr, arch, instruction pointer, then the args.
    const NR: u32 = 0;
    const ARCH: u32 = 4;
    const ARG0: u32 = 16;

    fn stmt(code: u16, k: u32) -> libc::sock_filter {
        libc::sock_filter {
            code,
            jt: 0,
            jf: 0,
            k,
        }
    }

    fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
        libc::sock_filter { code, jt, jf, k }
    }

    /// The socket families a boxed program may open.
    fn families(network: bool) -> Vec<u32> {
        if network {
            vec![
                libc::AF_INET as u32,
                libc::AF_INET6 as u32,
                libc::AF_NETLINK as u32,
            ]
        } else {
            Vec::new()
        }
    }

    /// The filter: a foreign architecture kills the process; `socket()`
    /// outside `families` and `io_uring_setup()` fail with EPERM; anything
    /// else is allowed. Laid out as:
    ///
    /// ```text
    ///   ld arch; jeq ARCH ? +1 : kill; kill; ld nr
    ///   [x86_64: jge 0x40000000 → deny]      x32 calls
    ///   jeq socket → family; jeq io_uring_setup → deny; ret allow
    /// family:
    ///   ld arg0; (jeq FAMILY → allow_family)…
    /// deny:
    ///   ret EPERM
    /// allow_family:
    ///   ret allow                              (when a family is allowed)
    /// ```
    pub(super) fn program(network: bool) -> Vec<libc::sock_filter> {
        let families = families(network);
        let x32_check = usize::from(cfg!(target_arch = "x86_64"));
        let socket_at = 4 + x32_check;
        let uring_at = socket_at + 1;
        let family_at = uring_at + 2;
        let deny_at = family_at + 1 + families.len();
        let allow_family_at = deny_at + 1;
        // A jump from `from` to `to`, as the offset after the next instruction.
        let offset = |from: usize, to: usize| (to - from - 1) as u8;

        let mut program = vec![
            stmt(LD_W_ABS, ARCH),
            jump(JEQ_K, AUDIT_ARCH.unwrap_or(0), 1, 0),
            stmt(RET_K, RET_KILL_PROCESS),
            stmt(LD_W_ABS, NR),
        ];
        #[cfg(target_arch = "x86_64")]
        program.push(jump(JGE_K, 0x4000_0000, offset(4, deny_at), 0));
        program.push(jump(
            JEQ_K,
            libc::SYS_socket as u32,
            offset(socket_at, family_at),
            0,
        ));
        program.push(jump(
            JEQ_K,
            libc::SYS_io_uring_setup as u32,
            offset(uring_at, deny_at),
            0,
        ));
        program.push(stmt(RET_K, RET_ALLOW));
        program.push(stmt(LD_W_ABS, ARG0));
        for (index, family) in families.iter().enumerate() {
            let at = family_at + 1 + index;
            program.push(jump(JEQ_K, *family, offset(at, allow_family_at), 0));
        }
        program.push(stmt(RET_K, RET_EPERM));
        if !families.is_empty() {
            program.push(stmt(RET_K, RET_ALLOW));
        }
        program
    }

    pub(super) fn install(network: bool) -> Result<(), String> {
        let mut filter = program(network);
        let prog = libc::sock_fprog {
            len: filter.len() as u16,
            filter: filter.as_mut_ptr(),
        };
        // SAFETY: plain prctl calls; `prog` points at `filter`, which outlives
        // them, and the kernel copies the program.
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(format!(
                    "could not set no_new_privs: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if libc::prctl(
                libc::PR_SET_SECCOMP,
                libc::SECCOMP_MODE_FILTER as libc::c_ulong,
                &prog as *const libc::sock_fprog as libc::c_ulong,
                0,
                0,
            ) != 0
            {
                return Err(format!(
                    "could not install the network filter: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_round_trips() {
        let plan = Plan {
            policy: SandboxPolicy::default(),
            project: "/tmp/work".into(),
            tmp: "/tmp/work/.tmp".into(),
        };
        let text = serde_json::to_string(&plan).unwrap();
        let back: Plan = serde_json::from_str(&text).unwrap();
        assert_eq!(back.project, plan.project);
    }

    /// Run the filter the way the kernel does, for one call.
    fn verdict(program: &[libc::sock_filter], arch: u32, nr: u32, arg0: u32) -> u32 {
        let (mut pc, mut acc) = (0usize, 0u32);
        loop {
            let insn = &program[pc];
            match insn.code {
                0x20 => {
                    acc = match insn.k {
                        0 => nr,
                        4 => arch,
                        16 => arg0,
                        other => panic!("load at {other}"),
                    }
                }
                0x15 | 0x35 => {
                    let taken = if insn.code == 0x15 {
                        acc == insn.k
                    } else {
                        acc >= insn.k
                    };
                    pc += usize::from(if taken { insn.jt } else { insn.jf });
                }
                0x06 => return insn.k,
                other => panic!("opcode {other:#x}"),
            }
            pc += 1;
        }
    }

    #[test]
    fn the_filter_refuses_sockets_unless_the_network_is_on() {
        let arch = seccomp::AUDIT_ARCH.unwrap();
        let socket = libc::SYS_socket as u32;
        let uring = libc::SYS_io_uring_setup as u32;
        let read = libc::SYS_read as u32;
        let allow = 0x7fff_0000;
        let eperm = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let (inet, unix) = (libc::AF_INET as u32, libc::AF_UNIX as u32);

        let closed = seccomp::program(false);
        assert_eq!(verdict(&closed, arch, read, 0), allow);
        assert_eq!(verdict(&closed, arch, socket, inet), eperm);
        assert_eq!(verdict(&closed, arch, socket, unix), eperm);
        assert_eq!(verdict(&closed, arch, uring, 0), eperm);
        assert_eq!(verdict(&closed, 0x4000_0003, read, 0), 0x8000_0000);

        let open = seccomp::program(true);
        assert_eq!(verdict(&open, arch, socket, inet), allow);
        assert_eq!(verdict(&open, arch, socket, libc::AF_INET6 as u32), allow);
        assert_eq!(verdict(&open, arch, socket, unix), eperm);
        assert_eq!(verdict(&open, arch, uring, 0), eperm);
        assert_eq!(verdict(&open, arch, read, 0), allow);
        #[cfg(target_arch = "x86_64")]
        assert_eq!(verdict(&open, arch, 0x4000_0000 | read, 0), eperm);
    }
}
