import os, sys, time, hashlib
from PIL import Image

# The Mini 5 Pro's internal storage over USB wedges after a few MB and
# eventually drops off the bus, so this reads in chunks, retries, verifies what
# it got, and skips anything already pulled. Re-run it after each disconnect.
#
#   python3 tools/pull-media.py [keep-list] [source-dir]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[2] if len(sys.argv) > 2 else '/Volumes/Untitled/DCIM/DJI_001'
DST = os.path.join(ROOT, 'captures')
KEEP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', '2026-08-28-keep.txt')
CH = 256 * 1024

def read_resilient(path, sz, budget=180):
    """The aircraft's USB gadget wedges after a few MB. Reopening at the failed
    offset gets it going again, so read in chunks and retry each one."""
    out = bytearray(); off = 0; fails = 0; t0 = time.time()
    while off < sz:
        if time.time() - t0 > budget:
            raise TimeoutError('gave up at %d/%d after %d retries' % (off, sz, fails))
        f = None
        try:
            f = os.open(path, os.O_RDONLY); os.lseek(f, off, 0)
            d = os.read(f, min(CH, sz - off))
            if not d: raise OSError('short read')
            out += d; off += len(d)
        except OSError:
            fails += 1
            if fails > 400: raise
            time.sleep(0.3)
        finally:
            if f is not None:
                try: os.close(f)
                except OSError: pass
    return bytes(out), fails

def verify(data, sz):
    """A retried read can come back silently wrong, so check content, not length.
    EOI is only warned about -- unconfirmed whether DJI appends past it."""
    if len(data) != sz: return 'size %d != %d' % (len(data), sz), False
    if data[:2] != b'\xff\xd8': return 'no JPEG SOI', False
    tail_ok = data.rfind(b'\xff\xd9') >= len(data) - 4096
    try:
        import io, warnings
        with warnings.catch_warnings():
            warnings.simplefilter('error')
            im = Image.open(io.BytesIO(data)); im.load()
        if im.size != (4096, 3072): return 'unexpected size %s' % (im.size,), tail_ok
    except Exception as e:
        return 'decode failed: %s' % e, tail_ok
    return None, tail_ok

def second_opinion(path, sz, first):
    """Files that needed retries get read again and compared -- a wedged gadget
    handing back a wrong block would otherwise pass unnoticed."""
    again, _ = read_resilient(path, sz)
    return hashlib.md5(again).digest() == hashlib.md5(first).digest()

names = [l.strip() for l in open(KEEP) if l.strip()]
ok, bad = [], []
for i, n in enumerate(names, 1):
    day = n.split('_')[1][:8]
    sub = '%s-%s-%s' % (day[:4], day[4:6], day[6:8])
    d = os.path.join(DST, sub); os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, n)
    src = os.path.join(SRC, n)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        print('%3d/%d skip (have) %s' % (i, len(names), n), flush=True); ok.append(n); continue
    try:
        sz = os.path.getsize(src)
        data, fails = read_resilient(src, sz)
        err, tail_ok = verify(data, sz)
        if err:
            print('%3d/%d BAD  %s -- %s' % (i, len(names), n, err), flush=True); bad.append((n, err)); continue
        if fails and not second_opinion(src, sz, data):
            print('%3d/%d BAD  %s -- two reads disagree' % (i, len(names), n), flush=True)
            bad.append((n, 'two reads disagree')); continue
        with open(dst, 'wb') as f: f.write(data)
        print('%3d/%d ok   %s  %.1f MB  retries=%d%s' % (i, len(names), n, sz/1e6, fails, '' if tail_ok else '  [no EOI near end]'), flush=True)
        ok.append(n)
    except Exception as e:
        print('%3d/%d FAIL %s -- %s' % (i, len(names), n, e), flush=True); bad.append((n, str(e)))

print('\n=== copied %d / %d ===' % (len(ok), len(names)), flush=True)
for n, e in bad: print('  FAILED %s: %s' % (n, e), flush=True)
