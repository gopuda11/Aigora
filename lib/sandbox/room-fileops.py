# Room file helper for write-capable endpoint workers (spec 2026-10-04 section 2.6).
# Run as:  python3 -I -S -c <this file's source> <workspace-dir>   inside the room scope (scope.wrap).
# stdin: {"ops":[{"op":"list"|"read"|"write"|"edit","path":"rel/path", ...}]}   stdout: {"results":[...]}
# Every path component is opened with O_NOFOLLOW relative to a directory fd (a planted symlink is never followed),
# absolute paths and ".." are refused, nothing under inbox/ is writable, agent instruction file names are refused for
# writes, and this helper never creates a symlink or hard link. It touches nothing outside the workspace argument.
import json, os, sys, errno, stat

MAX_READ = 65536
MAX_WRITE = 1048576
MAX_EDIT_FILE = 1048576
MAX_LIST = 200
MAX_PATH = 512
MAX_OPS = 8
MAX_RUN = 8 * 1048576  # default write budget of one request when the caller names none
budget = MAX_RUN  # bytes the remaining write/edit ops may still write (the actual size of each replacement file)
# Names other agents read as instructions (lowercase compare). Refused for write/edit at any depth.
INSTRUCTION = {"gemini.md", ".gemini", ".agents", "agents.md", "agents.override.md", "claude.md", "claude.local.md", ".claude", ".codex"}
FLAGS_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


class Refused(Exception):
    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


def parts_of(p, writing):
    if not isinstance(p, str) or "\0" in p or len(p) > MAX_PATH:
        raise Refused("bad_path")
    if p.startswith("/") or p.startswith("\\"):
        raise Refused("absolute_path")
    parts = [c for c in p.split("/") if c not in ("", ".")]
    if any(c == ".." for c in parts):
        raise Refused("parent_path")
    for c in parts:
        if len(c.encode("utf-8", "surrogatepass")) > 255:
            raise Refused("bad_path")
    if writing:
        if not parts:
            raise Refused("bad_path")
        if parts[0] == "inbox":
            raise Refused("inbox_readonly")
        for c in parts:
            if c.lower() in INSTRUCTION:
                raise Refused("instruction_file")
    return parts


def open_dir(root_fd, parts, create):
    """Walk `parts` below root_fd one component at a time (O_NOFOLLOW); returns an owned dir fd."""
    fd = os.open(".", FLAGS_DIR, dir_fd=root_fd)  # a fresh open file description (a dup would share the directory read position)
    try:
        for c in parts:
            try:
                nfd = os.open(c, FLAGS_DIR, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise Refused("not_found")
                os.mkdir(c, 0o755, dir_fd=fd)
                nfd = os.open(c, FLAGS_DIR, dir_fd=fd)
            except OSError as e:
                if e.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise Refused("symlink_or_not_directory")
                raise
            os.close(fd)
            fd = nfd
        return fd
    except BaseException:
        os.close(fd)
        raise


def op_list(root_fd, o):
    parts = parts_of(o.get("path", "."), False)
    fd = open_dir(root_fd, parts, False)
    try:
        out = []
        with os.scandir(fd) as it:
            names = sorted(e.name for e in it)
        truncated = len(names) > MAX_LIST
        for n in names[:MAX_LIST]:
            try:
                st = os.stat(n, dir_fd=fd, follow_symlinks=False)
            except OSError:
                continue
            kind = "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "link" if stat.S_ISLNK(st.st_mode) else "other"
            out.append({"name": n, "type": kind, "size": st.st_size if kind == "file" else 0})
        return {"entries": out, "truncated": truncated}
    finally:
        os.close(fd)


def open_file(root_fd, parts, flags):
    d = open_dir(root_fd, parts[:-1], False)
    try:
        try:
            f = os.open(parts[-1], flags | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=d)
        except FileNotFoundError:
            raise Refused("not_found")
        except OSError as e:
            if e.errno in (errno.ELOOP, errno.ENXIO, errno.EISDIR):
                raise Refused("symlink_or_not_file")
            raise
        st = os.fstat(f)
        if not stat.S_ISREG(st.st_mode):
            os.close(f)
            raise Refused("not_a_file")
        return f, st
    finally:
        os.close(d)


def op_read(root_fd, o):
    parts = parts_of(o.get("path"), False)
    if not parts:
        raise Refused("bad_path")
    off = o.get("offset", 0)
    lim = o.get("limit", MAX_READ)
    if not isinstance(off, int) or isinstance(off, bool) or off < 0 or not isinstance(lim, int) or isinstance(lim, bool) or lim < 1:
        raise Refused("bad_range")
    lim = min(lim, MAX_READ)
    f, st = open_file(root_fd, parts, os.O_RDONLY | os.O_NONBLOCK)
    try:
        os.lseek(f, off, os.SEEK_SET)
        data = os.read(f, lim)
    finally:
        os.close(f)
    return {"content": data.decode("utf-8", "replace"), "bytes": len(data), "size": st.st_size, "eof": off + len(data) >= st.st_size}


def atomic_write(root_fd, parts, data, mode):
    d = open_dir(root_fd, parts[:-1], True)
    tmp = None
    try:
        name = parts[-1]
        try:
            ex = os.stat(name, dir_fd=d, follow_symlinks=False)
            if not stat.S_ISREG(ex.st_mode):
                raise Refused("symlink_or_not_file")
        except FileNotFoundError:
            pass
        tmp = ".aigora-tmp-%d-%s" % (os.getpid(), os.urandom(4).hex())
        f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=d)
        try:
            view = memoryview(data)
            while len(view):
                n = os.write(f, view)
                view = view[n:]
            os.fchmod(f, mode)
        finally:
            os.close(f)
        os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp, dir_fd=d)
            except OSError:
                pass
        os.close(d)


def charge(n):
    global budget
    if n > budget:
        raise Refused("write_cap")
    budget -= n


def op_write(root_fd, o):
    parts = parts_of(o.get("path"), True)
    c = o.get("content")
    if not isinstance(c, str):
        raise Refused("bad_content")
    data = c.encode("utf-8", "replace")
    if len(data) > MAX_WRITE:
        raise Refused("too_large")
    charge(len(data))
    atomic_write(root_fd, parts, data, 0o644)
    return {"bytes": len(data)}


def op_edit(root_fd, o):
    parts = parts_of(o.get("path"), True)
    old, new = o.get("old"), o.get("new")
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise Refused("bad_edit")
    f, st = open_file(root_fd, parts, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if st.st_size > MAX_EDIT_FILE:
            raise Refused("too_large")
        data = os.read(f, MAX_EDIT_FILE + 1)
    finally:
        os.close(f)
    text = data.decode("utf-8", "replace")
    n = text.count(old)
    if n == 0:
        raise Refused("old_not_found")
    if n > 1:
        raise Refused("old_not_unique")
    out = text.replace(old, new, 1).encode("utf-8", "replace")
    if len(out) > MAX_WRITE:
        raise Refused("too_large")
    charge(len(out))
    atomic_write(root_fd, parts, out, st.st_mode & 0o777)
    return {"bytes": len(out)}


OPS = {"list": op_list, "read": op_read, "write": op_write, "edit": op_edit}


def main():
    if len(sys.argv) != 2 or not sys.argv[1].startswith("/"):
        sys.stdout.write(json.dumps({"fatal": "bad_root"}))
        return 2
    try:
        req = json.loads(sys.stdin.buffer.read(10 * 1024 * 1024).decode("utf-8"))
        ops = req["ops"]
        if not isinstance(ops, list) or len(ops) > MAX_OPS:
            raise ValueError("ops")
        rb = req.get("remainingBytes", MAX_RUN)
        if not isinstance(rb, int) or isinstance(rb, bool) or rb < 0:
            raise ValueError("remainingBytes")
        global budget
        budget = min(rb, MAX_RUN)
    except Exception:
        sys.stdout.write(json.dumps({"fatal": "bad_request"}))
        return 2
    try:
        root_fd = os.open(sys.argv[1], FLAGS_DIR)
    except OSError:
        sys.stdout.write(json.dumps({"fatal": "bad_root"}))
        return 2
    results = []
    for o in ops:
        try:
            if not isinstance(o, dict) or o.get("op") not in OPS:
                raise Refused("bad_op")
            r = OPS[o["op"]](root_fd, o)
            r["ok"] = True
            results.append(r)
        except Refused as e:
            results.append({"ok": False, "error": e.code})
        except OSError as e:
            results.append({"ok": False, "error": "io_" + errno.errorcode.get(e.errno, "error")})
        except Exception:
            results.append({"ok": False, "error": "internal"})
    sys.stdout.write(json.dumps({"results": results}))
    return 0


sys.exit(main())
