"""Watch a Doctolib booking motive for appointment availability.

Doctolib serves the booking data its own frontend uses over two public
JSON endpoints, no session required:

  1. /online_booking/api/slot_selection_funnel/v1/info.json
     -> practice metadata, including the agenda IDs that serve a motive
  2. /availabilities.json
     -> the slots those agendas offer, 15 days at a time, plus a
        `next_slot` pointer to the first opening beyond that window

Agenda IDs change when a practice reconfigures its calendars, so step 1
runs on every check rather than being cached in the config.

A time filter makes the second endpoint awkward: it answers "is anything
free?" but the question here is "is anything free after 16:00?", and one
window of morning slots hides every evening slot behind it. So the check
walks forward window by window (see `scan`) until it finds a match, and
rations that walk (see `look`) so the extra requests stay occasional.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta

WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


class UpstreamChanged(Exception):
    """Doctolib returned something we don't recognise.

    Raised instead of returning "nothing available" so that a silently
    broken watcher can never masquerade as a quiet one.
    """


@dataclass(frozen=True)
class Availability:
    """What the search found, counted after the time filter, not before.

    `total` is the number of slots that fit the filter in the window they
    were found in, and `next_slot` the earliest of them -- so an evening
    watcher never reports a morning slot it would not want.
    """

    available: bool
    total: int
    next_slot: str | None
    other_slot: str | None = None   # earliest slot the filter turned away
    seen: tuple = ()                # every slot walked past, for the histogram


def agenda_ids(info: dict, motive_id: int, practice_id: int) -> list[int]:
    """Agenda IDs that can currently be booked for this motive and practice."""
    agendas = info.get("data", {}).get("agendas")
    if not isinstance(agendas, list):
        raise UpstreamChanged("info.json has no agendas list")

    matched = [
        a["id"]
        for a in agendas
        if motive_id in a.get("visit_motive_ids", [])
        and a.get("practice_id") == practice_id
        and not a.get("booking_disabled")
        and not a.get("booking_temporary_disabled")
    ]
    if not matched:
        raise UpstreamChanged(
            f"no bookable agenda for motive {motive_id} at practice {practice_id}"
        )
    return sorted(matched)


def _hhmm(value: str | None):
    """"16:00" -> a time; None -> no bound."""
    return datetime.strptime(value, "%H:%M").time() if value else None


def in_time_window(iso: str, earliest: str | None, latest: str | None) -> bool:
    """True when the slot's own wall-clock time falls inside [earliest, latest].

    The offset in the timestamp is deliberately ignored: a slot Doctolib
    publishes as 15:00+01:00 is shown as 15:00 on the booking page, and
    15:00 is what "before 16:00" has to mean to be useful.
    """
    moment = datetime.fromisoformat(iso).time()
    low, high = _hhmm(earliest), _hhmm(latest)
    if low is not None and moment < low:
        return False
    if high is not None and moment > high:
        return False
    return True


def matching_slots(payload: dict, earliest: str | None, latest: str | None) -> list[str]:
    """Every slot in this 15-day window that falls inside the time filter.

    Deliberately blind to `next_slot`: that pointer leads outside the
    window, and following it is the scan's job.
    """
    days = payload.get("availabilities")
    if not isinstance(days, list):
        raise UpstreamChanged(f"availabilities.json returned {json.dumps(payload)[:200]}")

    slots = [s for day in days for s in day.get("slots", [])]
    return sorted(
        (s for s in slots if in_time_window(s, earliest, latest)),
        key=datetime.fromisoformat,
    )


def other_slots(payload: dict, earliest: str | None, latest: str | None) -> list[str]:
    """The complement of `matching_slots`: what the time filter turned away.

    Worth knowing even though it cannot be booked at a useful hour: it is
    the difference between "this practice has nothing" and "this practice
    has nothing *for you*", and only one of those is worth waiting for.
    """
    days = payload.get("availabilities")
    if not isinstance(days, list):
        raise UpstreamChanged(f"availabilities.json returned {json.dumps(payload)[:200]}")

    slots = [s for day in days for s in day.get("slots", [])]
    return sorted(
        (s for s in slots if not in_time_window(s, earliest, latest)),
        key=datetime.fromisoformat,
    )


WINDOW_DAYS = 15


def scan(fetch_window, start, horizon, earliest, latest, max_windows: int = 8) -> Availability:
    """Walk forward through 15-day windows until a slot fits the time filter.

    `fetch_window(start_date)` returns one availabilities.json body. The
    walk stops at the first match, at the horizon, or after max_windows,
    whichever comes first -- so the cheap case (a match in the first
    window) stays a single request.
    """
    cursor = start
    seen: list[str] = []
    other = None
    for _ in range(max_windows):
        if cursor > horizon:
            break
        payload = fetch_window(cursor)
        matches = matching_slots(payload, earliest, latest)
        rest = other_slots(payload, earliest, latest)
        seen.extend(sorted(matches + rest, key=datetime.fromisoformat))
        if other is None and rest:
            other = rest[0]
        if matches:
            return Availability(True, len(matches), matches[0], other, tuple(seen))
        cursor = _next_window(payload, cursor)
        if cursor is None:
            break
    return Availability(False, 0, None, other, tuple(seen))


def _next_window(payload: dict, cursor):
    """Where to look next, or None when Doctolib says there is nothing left.

    Three cases, and the third is the one worth having: a window whose
    slots exist but are all outside the time filter carries no pointer,
    yet later windows may still hold a match, so we step over it.
    """
    pointer = payload.get("next_slot")
    if pointer:
        # max(): a pointer must always move the cursor forwards.
        return max(datetime.fromisoformat(pointer).date(), cursor + timedelta(days=1))
    if any(day.get("slots") for day in payload["availabilities"]):
        return cursor + timedelta(days=WINDOW_DAYS)
    return None


def deep_scan_due(state: dict, now: datetime, minutes: int) -> bool:
    """Whether the far windows have gone unwalked long enough to walk again.

    The near window is cheap and checked every run; the windows behind it
    cost a request each, so they are rationed. `minutes` is the trade
    between how fresh a distant slot is and how hard we lean on Doctolib.
    """
    last = state.get("deep_scan_at")
    if not last:
        return True
    return now >= datetime.fromisoformat(last) + timedelta(minutes=minutes)


def look(fetch_window, state: dict, now: datetime, config: dict):
    """One look at Doctolib: the near window always, the far ones on a ration.

    Returns (availability, memory). The memory is what a throttled check
    leans on: without it, every run that skips the deep walk would report
    a distant evening slot as gone and re-alarm the moment it walked again.
    """
    earliest, latest = config.get("earliest_time"), config.get("latest_time")
    days = config.get("search_days", 90)
    today = now.date()
    horizon = today + timedelta(days=days)

    if deep_scan_due(state, now, config.get("deep_scan_minutes", 10)):
        found = scan(fetch_window, today, horizon, earliest, latest,
                     max_windows=days // WINDOW_DAYS + 1)
        return found, {
            "deep_scan_at": now.isoformat(),
            "deep_slot": found.next_slot,
            "deep_total": found.total,
        }

    memory = {
        "deep_scan_at": state.get("deep_scan_at"),
        "deep_slot": state.get("deep_slot"),
        "deep_total": state.get("deep_total", 0),
    }
    found = scan(fetch_window, today, horizon, earliest, latest, max_windows=1)
    if found.available or not memory["deep_slot"]:
        return found, memory
    return Availability(True, memory["deep_total"], memory["deep_slot"]), memory


# ASCII only: urllib encodes headers as latin-1, and a stray em dash
# would turn a found appointment into a UnicodeEncodeError.
PUSH_KINDS = {
    "alarm": {"Title": "Termin frei", "Priority": "urgent", "Tags": "bell"},
    "notice": {"Title": "Termin zu anderer Zeit", "Priority": "default", "Tags": "calendar"},
    "broken": {"Title": "Watcher gestoert", "Priority": "high", "Tags": "warning"},
}


def push_payload(config: dict, message: str, urgent: bool = True, kind: str | None = None):
    """The ntfy request for a found slot, or None when no topic is set.

    ntfy.sh is a public relay and the topic name is the only thing keeping
    the messages private, so the wording that reaches a lock screen says a
    slot exists and when, never what it is for. The booking URL in `Click`
    is the deliberate exception: tapping through has to land somewhere
    useful, and that URL carries the practice slug.
    """
    topic = config.get("ntfy_topic")
    if not topic:
        return None

    server = config.get("ntfy_server", "https://ntfy.sh").rstrip("/")
    kind = kind or ("alarm" if urgent else "notice")
    headers = dict(PUSH_KINDS[kind], Click=config["booking_url"])
    return f"{server}/{topic}", headers, message.encode("utf-8")


def with_env_overrides(config: dict, env) -> dict:
    """The file config, with ntfy settings taken from the environment if set.

    On the server the topic is a decrypted secret handed in as NTFY_TOPIC,
    so it never has to sit in a config file that might be committed.
    """
    updated = dict(config)
    for variable, key in (("NTFY_TOPIC", "ntfy_topic"), ("NTFY_SERVER", "ntfy_server")):
        if env.get(variable):
            updated[key] = env[variable]
    return updated


def headless_alarm_outcome(pushed: bool) -> str:
    """With no dialog to answer, a delivered push is the acknowledgement.

    Treating it as "opened" rings once per opening instead of every check;
    a lost push is "failed", so the next check tries again.
    """
    return "opened" if pushed else "failed"


def summarize(result: Availability) -> str:
    """One line for the alarm, in the language the booking site uses."""
    if result.available:
        when = _format_slot(result.next_slot)
        if result.total:
            return f"{result.total} Termine ab {when}"
        return f"Nächster Termin: {when}"
    if result.other_slot:
        return f"Termin außerhalb deiner Zeiten: {_format_slot(result.other_slot)}"
    return "keine Termine verfügbar"


def _format_slot(iso: str | None) -> str:
    if not iso:
        return "unbekannt"
    moment = datetime.fromisoformat(iso)
    return f"{WEEKDAYS_DE[moment.weekday()]} {moment:%d.%m.%Y, %H:%M}"


def decide(state: dict, available: bool, now: datetime) -> str:
    """Alarm only on the transition into availability, and never while snoozed."""
    if not available or state.get("available"):
        return "silent"
    snooze_until = state.get("snooze_until")
    if snooze_until and now < datetime.fromisoformat(snooze_until):
        return "silent"
    return "alarm"


SLOT_MEMORY = 200


def remember_slots(previous, seen, limit: int = SLOT_MEMORY) -> list[str]:
    """Every distinct slot this watcher has ever seen, newest `limit` kept.

    Kept because the practice publishes no opening hours, so the only way
    to learn whether it ever offers an evening appointment is to write
    down what actually turns up.
    """
    merged = sorted(set(previous) | set(seen), key=datetime.fromisoformat)
    return merged[-limit:]


def slot_histogram(slots) -> dict:
    """How many of those slots started in each hour of the day."""
    counts: dict = {}
    for iso in slots:
        hour = datetime.fromisoformat(iso).hour
        counts[hour] = counts.get(hour, 0) + 1
    return counts


def stats_lines(config: dict, state: dict) -> list[str]:
    """What hours this practice actually offers, as far as anyone can tell.

    The practice publishes no opening hours, so this is the only evidence
    there is for whether a time filter is selective or simply blind.
    """
    slots = state.get("seen_slots", [])
    if not slots:
        return ["Noch keine Termine beobachtet."]

    earliest, latest = config.get("earliest_time"), config.get("latest_time")
    fitting = [s for s in slots if in_time_window(s, earliest, latest)]
    bounds = f"{earliest or '--:--'} bis {latest or '--:--'}"

    histogram = slot_histogram(slots)
    peak = max(histogram.values())
    lines = [
        f"{len(fitting)} von {len(slots)} beobachteten Terminen liegen "
        f"in deinem Zeitfenster ({bounds}).",
        "",
    ]
    for hour in sorted(histogram):
        count = histogram[hour]
        fits = in_time_window(f"2000-01-01T{hour:02d}:00:00", earliest, latest)
        lines.append(
            f"  {hour:02d}:00  {'#' * max(1, count * 20 // peak):<20}  "
            f"{count:>3}  {'<- Alarm' if fits else ''}".rstrip()
        )
    return lines


def decide_notice(state: dict, other_available: bool, now: datetime) -> str:
    """The quiet tier: tell me once that something opened at a useless hour.

    Deliberately ignores the snooze, which silences the ringing alarm and
    says nothing about banners.
    """
    if not other_available or state.get("other_available"):
        return "silent"
    return "notice"


def next_state(state: dict, result: Availability, now: datetime,
               memory: dict | None = None) -> dict:
    """State to persist after a check that reached Doctolib successfully."""
    updated = {
        "available": result.available,
        "other_available": bool(result.other_slot),
        "last_check": now.isoformat(),
        "consecutive_failures": 0,
        "broken_warned": False,
        "snooze_until": state.get("snooze_until"),
        "seen_slots": remember_slots(state.get("seen_slots", []), result.seen),
    }
    updated.update(memory or {})
    return updated


def should_warn_broken(state: dict, threshold: int) -> bool:
    """Warn once when the watcher has been failing long enough to distrust its silence."""
    if state.get("broken_warned"):
        return False
    return state.get("consecutive_failures", 0) >= threshold


INFO_URL = (
    "https://www.doctolib.de/online_booking/api/slot_selection_funnel/v1/info.json"
    "?profile_slug={slug}&locale=de"
)
AVAILABILITIES_URL = (
    "https://www.doctolib.de/availabilities.json"
    "?start_date={start}&visit_motive_ids={motive}&agenda_ids={agendas}"
    "&practice_ids={practice}&insurance_sector={sector}&telehealth=false&limit=15"
)


@dataclass(frozen=True)
class CheckResult:
    action: str  # "alarm" | "notice" | "silent" | "broken"
    state: dict
    message: str


def run_check(config: dict, state: dict, now: datetime, fetch_json) -> CheckResult:
    """One poll of Doctolib, reduced to an action and the state to persist."""
    try:
        info = fetch_json(INFO_URL.format(slug=config["profile_slug"]))
        agendas = agenda_ids(info, config["motive_id"], config["practice_id"])

        def fetch_window(start):
            return fetch_json(
                AVAILABILITIES_URL.format(
                    start=start.isoformat(),
                    motive=config["motive_id"],
                    agendas="-".join(str(a) for a in agendas),
                    practice=config["practice_id"],
                    sector=config["insurance_sector"],
                )
            )

        result, memory = look(fetch_window, state, now, config)
    except (OSError, ValueError, UpstreamChanged) as exc:
        return _failed_check(config, state, now, exc)

    # The loud tier gets first refusal; the quiet one speaks only when it
    # has nothing to say.
    action = decide(state, result.available, now)
    if action == "silent":
        action = decide_notice(state, bool(result.other_slot), now)

    return CheckResult(
        action=action,
        state=next_state(state, result, now, memory),
        message=summarize(result),
    )


def _failed_check(config: dict, state: dict, now: datetime, exc: Exception) -> CheckResult:
    """A failed check must never be mistaken for 'nothing available'."""
    failed = dict(state)
    failed["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
    failed["last_check"] = now.isoformat()
    failed["last_error"] = f"{type(exc).__name__}: {exc}"
    threshold = config.get("failure_threshold", 12)
    if should_warn_broken(failed, threshold):
        failed["broken_warned"] = True
        return CheckResult("broken", failed, failed["last_error"])
    return CheckResult("silent", failed, failed["last_error"])


def apply_alarm_outcome(state: dict, outcome: str, now: datetime, snooze_minutes: int) -> dict:
    """Fold the user's answer to the alarm dialog back into the state.

    "opened"  -> they have seen it; stay quiet until availability comes back
    "snoozed" -> re-arm, but hold fire until the snooze expires
    "failed"  -> the dialog never appeared, so treat the alarm as undelivered
    """
    updated = dict(state)
    if outcome == "opened":
        updated["available"] = True
        updated["snooze_until"] = None
    elif outcome == "snoozed":
        updated["available"] = False
        updated["snooze_until"] = (now + timedelta(minutes=snooze_minutes)).isoformat()
    else:
        updated["available"] = False
        updated["snooze_until"] = None
    return updated


# --------------------------------------------------------------------------
# Shell: HTTP, state file, alarm process, CLI
# --------------------------------------------------------------------------

import argparse
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Overridable so a container can keep config and state on mounted volumes.
CONFIG_PATH = Path(os.environ.get("DOCTOLIB_CONFIG", HERE / "config.json"))
STATE_PATH = Path(os.environ.get("DOCTOLIB_STATE", HERE / "state.json"))
ALARM_PATH = HERE / "alarm.sh"
# No screen, no speaker: the phone push is the only channel (see README).
HEADLESS = os.environ.get("DOCTOLIB_HEADLESS") == "1"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
ALARM_EXIT = {0: "opened", 10: "snoozed", 20: "failed"}


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def log(message: str) -> None:
    print(f"{datetime.now().astimezone():%Y-%m-%d %H:%M:%S}  {message}", flush=True)


def load_json(path: Path, default: dict | None = None) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        if default is None:
            raise
        return default


def ring(config: dict, message: str) -> str:
    """Run the alarm and report which button ended it."""
    completed = subprocess.run(
        [
            str(ALARM_PATH),
            "🔔 Doctolib: Termin verfügbar!",
            f"{config['label']}\n\n{message}",
            config["booking_url"],
            config.get("sound", "/System/Library/Sounds/Sonar.aiff"),
            str(config.get("alarm_seconds", 120)),
        ]
    )
    return ALARM_EXIT.get(completed.returncode, "failed")


def push(config: dict, message: str, urgent: bool = True, kind: str | None = None) -> bool:
    """Send the phone notification. Never fatal: a push is a courtesy copy.

    Returns whether it was delivered, which matters only when headless,
    where the push is not a copy but the alarm itself.
    """
    payload = push_payload(config, message, urgent, kind)
    if not payload:
        return False
    url, headers, body = payload
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=body, headers=headers), timeout=10
        ):
            log(f"pushed to {url.rsplit('/', 1)[0]}/…")
        return True
    except OSError as exc:
        log(f"push failed: {type(exc).__name__}: {exc}")
        return False


def banner(title: str, message: str, url: str | None = None) -> bool:
    """A clickable Notification Centre banner. False if it could not be shown."""
    if not shutil.which("terminal-notifier"):
        return False
    command = ["terminal-notifier", "-title", title, "-message", message,
               "-group", "doctolib-watch-notice"]
    if url:
        command += ["-open", url]
    return subprocess.run(command, capture_output=True).returncode == 0


def notify(title: str, message: str, url: str | None = None) -> None:
    """A plain banner, for things that should not ring."""
    if banner(title, message, url):
        return
    subprocess.run(
        ["osascript", "-e", f'display notification "{message}" with title "{title}"'],
        check=False,
    )


def notice(config: dict, message: str) -> None:
    """The quiet tier: a slot exists, just not at an hour you asked for.

    No sound and nothing blocking -- it is information, not an alarm.
    """
    push(config, message, urgent=False)
    if not HEADLESS:
        notify("Doctolib: Termin zu anderer Zeit", message, config["booking_url"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="check and report, but never ring and never save state")
    parser.add_argument("--test-alarm", action="store_true",
                        help="ring the alarm now, to prove sound and dialog work")
    parser.add_argument("--reset", action="store_true", help="forget the remembered state")
    parser.add_argument("--stats", action="store_true",
                        help="show which hours this practice has actually offered")
    args = parser.parse_args(argv)

    config = with_env_overrides(load_json(CONFIG_PATH), os.environ)

    if args.test_alarm:
        # Both channels, so one command proves the whole delivery path.
        pushed = push(config, "Test — Mi 16.09.2026, 17:30")
        if HEADLESS:
            log(f"test push {'delivered' if pushed else 'FAILED'}")
            return 0 if pushed else 1
        outcome = ring(config, "Test — Mi 16.09.2026, 17:30")
        log(f"test alarm dismissed with: {outcome}")
        return 0 if outcome != "failed" else 1

    if args.stats:
        for line in stats_lines(config, load_json(STATE_PATH, default={})):
            print(line)
        return 0

    if args.reset:
        STATE_PATH.unlink(missing_ok=True)
        log("state cleared")
        return 0

    state = load_json(STATE_PATH, default={})
    now = datetime.now().astimezone()
    result = run_check(config, state, now, fetch_json)

    log(f"{result.action}: {result.message}")

    if args.dry_run:
        return 0

    if result.action == "alarm":
        # Push first: ring() blocks until the dialog is answered, and the
        # phone is the copy that matters when nobody is at the Mac.
        pushed = push(config, result.message)
        if HEADLESS:
            outcome = headless_alarm_outcome(pushed)
        else:
            outcome = ring(config, result.message)
        log(f"alarm dismissed with: {outcome}")
        result = CheckResult(
            result.action,
            apply_alarm_outcome(result.state, outcome, now, config.get("snooze_minutes", 30)),
            result.message,
        )
    elif result.action == "notice":
        notice(config, result.message)
    elif result.action == "broken":
        warning = (f"{result.state.get('consecutive_failures', 0)} Fehlversuche in Folge. "
                   "Keine Nachricht heißt gerade NICHT: keine Termine.")
        if HEADLESS:
            push(config, warning, kind="broken")
        else:
            notify("⚠️ Doctolib-Watcher gestört", warning)

    STATE_PATH.write_text(json.dumps(result.state, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
