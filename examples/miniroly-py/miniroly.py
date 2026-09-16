#!/usr/bin/env python3
"""miniroly-py: a PAAP v0.1 L1 Reader in Python, standard library only.

python3 miniroly.py read <capsule-dir> [--json]  ->  the section 8.1 summary, or a summary and the section 7 brief.
Exit 0 = read, 1 = broken capsule (reason on stderr), 2 = usage.
"""
import hashlib
import json
import os
import re
import sys

PROTOCOL = "paap/0.1"
BRIEF = ["goal", "current_state", "decisions", "unresolved_questions", "failed_attempts",
         "relevant_artifacts", "relevant_memory", "git_state", "capability_requirements"]


def obj(*names, **nested):
    """The keys an object may have. None = any value (ext, body values, JWKs stay open)."""
    return {**{n: None for n in names}, **nested}


MANIFEST = obj("protocol", "exported_at", "ext", exporter=obj("name", "version"),
               contents=[obj("path", "sha256")], reenter=obj("credential_refs", "devices"))
IDENTITY = obj("protocol", "account_id", "agent_id", "display_name", "owner", "exported_at", "ext",
               handles=[obj("handle", "status", "authority")],
               keys=obj(account=obj("key_id", "jwk"), devices=[obj("id", "name", "jwk", "revoked_at")]))
WORK = obj("id", "owner", "title", "goal", "status", "visibility", "profile", "parent_work_id",
           "created_at", "updated_at", "ext", lease=obj("epoch", "holder_run", "acquired_at", "expires_at"),
           forked_from=obj("work_id", "checkpoint_version"))
CHECKPOINT = obj("work_id", "version", "write_epoch", "run_id", "content_hash", "created_at", "ext",
                 body=obj(*BRIEF), based_on=obj("work_id", "version"))
HANDOFF = obj("id", "work_id", "from_run", "from_epoch", "reserved_epoch", "to_runtime", "source_state",
              "checkpoint_version", "state", "reason", "note", "expires_at", "created_at", "updated_at", "ext")
LAYOUT = re.compile(r"works/([^/]+)/(?:work\.json|checkpoints/([^/]+)\.json|handoffs/([^/]+)\.json)")
TIMESTAMP = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z")


class Bad(Exception):
    """args = (reason from spec section 9, path at fault)."""


def strict(value, shape, where):
    """I-10: a key the schema does not define is rejected, at every level."""
    if isinstance(shape, list):
        if not isinstance(value, list):
            raise Bad("invalid_field", where)
        for item in value:
            strict(item, shape[0], where)
    elif isinstance(shape, dict):
        if not isinstance(value, dict):
            raise Bad("invalid_field", where)
        for key, item in value.items():
            if key not in shape:
                raise Bad("unknown_key", where)
            if shape[key] is not None:
                strict(item, shape[key], where)


def no_duplicates(pairs):
    if len({k for k, _ in pairs}) != len(pairs):
        raise ValueError("duplicate key")  # I-JSON (section 2)
    return dict(pairs)


def no_constant(name):
    raise ValueError(name)  # NaN / Infinity are not JSON


def parse(data, where, shape):
    try:
        doc = json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates, parse_constant=no_constant, parse_float=lambda s: int(float(s)) if float(s).is_integer() else float(s))  # 3.0 is 3 (section 2)
    except ValueError:
        raise Bad("invalid_json", where)
    if not isinstance(doc, dict):
        raise Bad("invalid_json", where)
    if "protocol" in shape and doc.get("protocol") != PROTOCOL:
        raise Bad("unsupported_protocol", where)
    strict(doc, shape, where)
    return doc


def read_capsule(root):
    raw = {}
    for folder, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]  # dot entries are not part of a capsule (section 3)
        for name in names:
            if not name.startswith("."):
                path = os.path.join(folder, name)
                with open(path, "rb") as f:
                    raw[os.path.relpath(path, root).replace(os.sep, "/")] = f.read()
    for required in ("manifest.json", "identity.json"):
        if required not in raw:
            raise Bad("missing_file", required)
    manifest = parse(raw.pop("manifest.json"), "manifest.json", MANIFEST)
    listed = [c["path"] for c in manifest["contents"]]
    if len(set(listed)) != len(listed) or set(listed) != set(raw):
        raise Bad("manifest_contents_mismatch", "manifest.json")
    for c in manifest["contents"]:
        if hashlib.sha256(raw[c["path"]]).hexdigest() != c["sha256"]:
            raise Bad("manifest_hash_mismatch", c["path"])
    identity = parse(raw["identity.json"], "identity.json", IDENTITY)
    works = {}
    for path in sorted(raw):
        m = LAYOUT.fullmatch(path)
        if not m:
            continue  # readers ignore listed paths they do not understand (section 3)
        work_id, version, handoff_id = m.groups()
        kind, shape, place = (("checkpoints", CHECKPOINT, {"work_id": work_id, "version": version}) if version
                              else ("handoffs", HANDOFF, {"work_id": work_id, "id": handoff_id}) if handoff_id
                              else ("work", WORK, {"id": work_id}))
        doc = parse(raw[path], path, shape)
        if any(str(doc[key]) != value for key, value in place.items()):
            raise Bad("path_mismatch", path)  # I-1: the location agrees with id / work_id / version
        works.setdefault(work_id, {"work": [], "checkpoints": [], "handoffs": []})[kind].append(doc)
    for work_id, entry in works.items():
        if not entry["work"]:
            raise Bad("missing_file", "works/%s/work.json" % work_id)
    return manifest, identity, works


def utf16(text):
    return text.encode("utf-16-be")  # "sorted" = UTF-16 code units (section 2)


def instant(stamp, field):
    """Timestamps compare as instants: '…:00Z' is earlier than '…:00.5Z', which string order gets wrong."""
    m = TIMESTAMP.fullmatch(stamp) if isinstance(stamp, str) else None
    if not m:
        raise Bad("invalid_field", field)
    return m.group(1), int((m.group(2) or "").ljust(9, "0"))


def latest(items, field):
    """The item with the latest timestamp; ties go to the sorted-first id (section 8.1)."""
    items = sorted(items, key=lambda item: utf16(item["id"]))
    items.sort(key=lambda item: instant(item[field], field), reverse=True)  # stable, so ties keep id order
    return items[0] if items else None


def summarize(manifest, identity, works):
    current = [h["handle"] for h in identity["handles"] if h["status"] == "current"]
    if len(current) > 1:
        raise Bad("invalid_field", "identity.json")
    work = latest([e["work"][0] for e in works.values() if e["work"][0]["status"] != "done"], "updated_at")
    checkpoint = handoff = None
    if work:
        checkpoint = max(works[work["id"]]["checkpoints"], key=lambda c: c["version"], default=None)
        handoff = latest(works[work["id"]]["handoffs"], "created_at")
    summary = {
        "protocol": manifest["protocol"],
        "handle": "@" + current[0] if current else None,
        "display_name": identity["display_name"],
        "current_work": work and {k: work[k] for k in ("id", "title", "status")},
        "latest_checkpoint": checkpoint and {
            "version": checkpoint["version"], "write_epoch": checkpoint["write_epoch"],
            "content_hash": checkpoint["content_hash"],
            "brief_sections": [f for f in BRIEF if f in checkpoint["body"]]},
        "last_handoff": handoff and {k: handoff[k] for k in ("id", "state", "to_runtime", "reserved_epoch")},
        "reenter": manifest["reenter"],
    }
    return summary, checkpoint


def brief(body):
    """Section 7: '## <field>', a newline, the value (strings as they are, others as 2-space JSON)."""
    return "\n\n".join("## %s\n%s" % (f, body[f] if isinstance(body[f], str)
                                      else json.dumps(body[f], indent=2, ensure_ascii=False))
                       for f in BRIEF if f in body)


def main(argv):
    if len(argv) < 2 or argv[0] != "read" or not os.path.isdir(argv[1]):
        print("usage: python3 miniroly.py read <capsule-dir> [--json]", file=sys.stderr)
        return 2
    try:
        summary, checkpoint = summarize(*read_capsule(argv[1]))
    except (Bad, KeyError, TypeError, AttributeError) as e:
        reason = e.args if isinstance(e, Bad) else ("missing_field", e.args[0]) if isinstance(e, KeyError) else ("invalid_field", "")
        print(("error: %s %s" % reason).rstrip(), file=sys.stderr)
        return 1
    if "--json" in argv[2:]:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    work, cp, handoff, reenter = (summary[k] for k in ("current_work", "latest_checkpoint", "last_handoff", "reenter"))
    print("%s  %s" % (summary["handle"] or "(no handle)", summary["display_name"]))
    print("work        %(id)s  %(title)s  [%(status)s]" % work if work else "work        (none open)")
    if cp:
        print("checkpoint  v%(version)s  epoch %(write_epoch)s" % cp)
    if handoff:
        print("handoff     %(id)s  %(state)s -> %(to_runtime)s  epoch %(reserved_epoch)s" % handoff)
    print("re-enter    %s  devices %s" % (", ".join(reenter["credential_refs"]) or "no secrets", reenter["devices"]))
    if checkpoint:
        print("\n" + brief(checkpoint["body"]))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # display names are not ASCII everywhere
    sys.exit(main(sys.argv[1:]))
