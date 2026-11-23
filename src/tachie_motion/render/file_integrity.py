"""Identity-bound content proofs for publishing previously verified media.

The proof is tied to an open regular-file descriptor and the pathname's
identity.  A hard link legitimately changes ctime, so publication checks may
ignore that one field *only after* the link is created; the content digest and
the originating inode must still match.
"""

from dataclasses import dataclass
from hashlib import sha256
import os
from pathlib import Path
import stat


@dataclass(frozen=True)
class FileProof:
    dev: int
    ino: int
    ctime_ns: int
    size: int
    mtime_ns: int
    digest: str


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Verified media is not a regular file")
    return (info.st_dev, info.st_ino, info.st_ctime_ns,
            info.st_size, info.st_mtime_ns)


def prove_file(path: Path) -> FileProof:
    """Hash exactly the inode currently named by path, rejecting races.

    An external writer modifying a file during hashing changes its ctime,
    which is compared before/after reading.  A replaced path is also refused.
    """
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        before = _identity(os.fstat(fd))
        digest = sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        after = _identity(os.fstat(fd))
        if before != after or _identity(path.lstat()) != after:
            raise RuntimeError("Verified media changed while being inspected")
        return FileProof(*after, digest.hexdigest())
    finally:
        os.close(fd)


def require_file_proof(path: Path, expected: FileProof, *,
                       linked: bool = False) -> FileProof:
    actual = prove_file(path)
    if linked:
        # The publisher's own os.link() changes ctime on the shared inode.
        fields = lambda proof: (proof.dev, proof.ino, proof.size,
                                proof.mtime_ns, proof.digest)
    else:
        fields = lambda proof: proof
    if fields(actual) != fields(expected):
        raise RuntimeError("Verified media changed before or during publication")
    return actual
