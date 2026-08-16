#!/usr/bin/env python3
"""Public, aggregate collection trigger for ballistic suppression research.

This module never infers a destroyed launcher and never changes live risk.  It
only opens an evidence-collection watch after a recent official Ukrainian
report that names a ballistic launch-chain target.  Raw post text and precise
locations are deliberately excluded from the returned state.
"""
from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timedelta, timezone
from typing import Any


WATCH_WINDOW = timedelta(hours=6)

TARGET_RE = re.compile(
    r"(?:\bотрк\b|іскандер|искандер|пусков\w*\s+установ\w*|"
    r"балістич\w*\s+(?:ракет\w*|комплекс\w*)|ballistic\s+(?:missile\s+)?launcher)",
    re.IGNORECASE,
)
STRIKE_RE = re.compile(
    r"(?:уражен\w*|знищен\w*|пошкоджен\w*|завдан\w*\s+удар\w*|нанесен\w*\s+удар\w*)",
    re.IGNORECASE,
)
ALLY_RE = re.compile(
    r"(?:сили\s+оборони|збройн\w*\s+сил\w*\s+україни|українськ\w*\s+(?:військ|підрозділ))",
    re.IGNORECASE,
)
ENEMY_ATTACK_RE = re.compile(
    r"(?:ворог|противник|російськ\w*)\s+(?:завдав|наніс|здійснив|атакував)",
    re.IGNORECASE,
)
PHYSICAL_IMPACT_RE = re.compile(
    r"(?:пожар\w*|возгоран\w*|поврежден\w*|детонац\w*|эвакуир\w*|ликвидац\w*)",
    re.IGNORECASE,
)
FUNCTION_STOP_RE = re.compile(
    r"(?:приостановлен\w*|остановлен\w*|не\s+работает|выведен\w*\s+из\s+строя)",
    re.IGNORECASE,
)
FUNCTION_RESTORE_RE = re.compile(
    r"(?:восстановлен\w*|возобновлен\w*|работа\s+возобновлена)",
    re.IGNORECASE,
)

REGION_BUCKETS = (
    (re.compile(r"брянськ|брянск", re.IGNORECASE), "BRY"),
    (re.compile(r"курськ|курск", re.IGNORECASE), "KUR"),
    (re.compile(r"б[єе]лгород|белгород", re.IGNORECASE), "BEL"),
    (re.compile(r"воронез", re.IGNORECASE), "VOR"),
    (re.compile(r"крим|крым", re.IGNORECASE), "CRI"),
    (re.compile(r"ростов|таганрог", re.IGNORECASE), "ROS"),
)


def _utc(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _plain(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.IGNORECASE)
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def telegram_posts(page: str, expected_channel: str) -> list[dict[str, Any]]:
    """Extract timestamped public posts without returning rendered HTML."""
    if not isinstance(page, str) or not page:
        return []
    markers = list(re.finditer(r'data-post="([^"/]+)/([0-9]+)"', page))
    posts: list[dict[str, Any]] = []
    for index, marker in enumerate(markers):
        if marker.group(1).casefold() != expected_channel.casefold():
            continue
        end = markers[index + 1].start() if index + 1 < len(markers) else len(page)
        block = page[marker.start():end]
        time_match = re.search(r'<time[^>]+datetime="([^"]+)"', block, re.IGNORECASE)
        text_match = re.search(
            r'<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>',
            block,
            re.IGNORECASE | re.DOTALL,
        )
        published = _utc(time_match.group(1)) if time_match else None
        text = _plain(text_match.group(1)) if text_match else ""
        if published and text:
            posts.append({"post_id": marker.group(2), "published_utc": published, "text": text})
    return posts


def _is_official_launch_chain_strike(text: str) -> bool:
    if not TARGET_RE.search(text) or not STRIKE_RE.search(text):
        return False
    starts_as_official_result = bool(re.match(r"^уражено\b", text, re.IGNORECASE))
    if ENEMY_ATTACK_RE.search(text) and not ALLY_RE.search(text) and not starts_as_official_result:
        return False
    return bool(ALLY_RE.search(text) or starts_as_official_result)


def _regions(text: str) -> list[str]:
    return [bucket for pattern, bucket in REGION_BUCKETS if pattern.search(text)]


def _aggressor_summary(page: str, channel: str, anchor: datetime) -> dict[str, Any]:
    posts = telegram_posts(page, channel)
    recent = [post for post in posts if timedelta(0) <= anchor - post["published_utc"] <= WATCH_WINDOW]
    physical = sum(bool(PHYSICAL_IMPACT_RE.search(post["text"])) for post in recent)
    stopped = sum(bool(FUNCTION_STOP_RE.search(post["text"])) for post in recent)
    restored = sum(bool(FUNCTION_RESTORE_RE.search(post["text"])) for post in recent)
    latest = max((post["published_utc"] for post in posts), default=None)
    if not page:
        status = "UNKNOWN"
        classification = "SOURCE_NOT_COLLECTED"
    elif not posts:
        status = "PARTIAL"
        classification = "PUBLIC_PAGE_PARSED_NO_TIMESTAMPED_POSTS"
    elif restored:
        status = "VERIFIED_DONE"
        classification = "UNLINKED_FUNCTION_RESTORATION_MARKER_OBSERVED"
    elif stopped:
        status = "VERIFIED_DONE"
        classification = "UNLINKED_FUNCTION_STOP_MARKER_OBSERVED"
    elif physical:
        status = "VERIFIED_DONE"
        classification = "UNLINKED_PHYSICAL_IMPACT_MARKER_OBSERVED"
    else:
        status = "VERIFIED_DONE"
        classification = "NO_RELEVANT_MARKER_OBSERVED_IN_SAMPLED_OUTPUT"
    return {
        "collection_status": status,
        "classification": classification,
        "recent_post_count": len(recent),
        "unlinked_physical_marker_count": physical,
        "unlinked_function_stop_marker_count": stopped,
        "unlinked_function_restore_marker_count": restored,
        "latest_publication_utc": _iso(latest),
        "functional_bda_qualified": False,
    }


def build_public_suppression_watch(
    *,
    ukrainian_page: str,
    aggressor_pages: dict[str, str] | None,
    anchor_utc: str,
) -> dict[str, Any]:
    anchor = _utc(anchor_utc)
    if anchor is None:
        raise ValueError("invalid anchor_utc")
    source_posts = telegram_posts(ukrainian_page, "GeneralStaffZSU")
    recent = [post for post in source_posts if timedelta(0) <= anchor - post["published_utc"] <= WATCH_WINDOW]
    candidates = [post for post in recent if _is_official_launch_chain_strike(post["text"])]
    candidate_regions = sorted({bucket for post in candidates for bucket in _regions(post["text"])})
    latest_source = max((post["published_utc"] for post in source_posts), default=None)
    latest_candidate = max((post["published_utc"] for post in candidates), default=None)
    if not ukrainian_page:
        collection_status = "UNKNOWN"
        candidate_state = "UNKNOWN"
    elif not source_posts:
        collection_status = "PARTIAL"
        candidate_state = "UNKNOWN"
    else:
        collection_status = "VERIFIED_DONE"
        candidate_state = "PUBLIC_TRIGGER_DETECTED" if candidates else "NOT_OBSERVED_IN_SAMPLED_OUTPUT"

    aggressor_pages = aggressor_pages or {}
    aggressor = {
        "RUSSIAN_MOD_PUBLIC": _aggressor_summary(aggressor_pages.get("mod_russia", ""), "mod_russia", anchor),
        "RUSSIAN_EMERGENCY_MINISTRY_PUBLIC": _aggressor_summary(aggressor_pages.get("mchs_official", ""), "mchs_official", anchor),
    }
    trigger_hashes = sorted(
        hashlib.sha256(post["text"].encode("utf-8")).hexdigest()
        for post in candidates
    )
    return {
        "schema_version": 1,
        "collection_status": collection_status,
        "action": "OPEN_SUPPRESSION_WATCH" if candidates else "ROUTINE_PUBLIC_SCAN",
        "candidate_state": candidate_state,
        "window_hours": 6,
        "source_scope": "SAMPLED_OFFICIAL_PUBLIC_PAGE_NOT_COMPLETE_COVERAGE",
        "source_latest_publication_utc": _iso(latest_source),
        "latest_candidate_publication_utc": _iso(latest_candidate),
        "first_seen_utc": anchor_utc if candidates else None,
        "candidate_count_6h": len(candidates),
        "candidate_region_buckets": candidate_regions,
        "candidate_text_sha256": trigger_hashes,
        "aggressor_readback": aggressor,
        "evidence_effect": "NONE",
        "applied_delta_points": 0,
        "current_threat_state_updated": False,
        "reason": "COLLECT_MORE_PUBLIC_AGGREGATE_EVIDENCE_NO_LIVE_RISK_REDUCTION",
    }
