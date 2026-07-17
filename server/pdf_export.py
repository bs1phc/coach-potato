"""Renders a champion's Champ guide (general notes + every matchup: patch,
rune pages, Markdown notes) as a printable PDF. Rune/tree/shard icons are
fetched live from ddragon/CommunityDragon at export time (same CDN URLs the
frontend hotlinks in guide.js) and embedded — unlike the JSON export, this
needs network access and is slower. Uses reportlab's core Helvetica fonts
(WinAnsi/Latin-1 only) — non-Latin characters in notes won't render
correctly; embedding a Unicode font was judged out of scope for a v1.
"""
import html
import io
import re

import httpx
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable, Image, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from . import rune_data

RUNE_ICON_URL = "https://ddragon.leagueoflegends.com/cdn/img/{}"
SHARD_ICON_URL = ("https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data"
                   "/global/default/v1/perk-images/statmods/{}")
ICON_PT = 16  # rune/shard icon size in the PDF, in points


def _styles():
    base = getSampleStyleSheet()
    return {
        "Title": base["Title"],
        "H1": ParagraphStyle("GuideH1", parent=base["Heading1"], spaceBefore=14, spaceAfter=6),
        "H2": ParagraphStyle("GuideH2", parent=base["Heading2"], spaceBefore=10, spaceAfter=4),
        "H3": ParagraphStyle("GuideH3", parent=base["Heading3"], spaceBefore=8, spaceAfter=3),
        "Body": ParagraphStyle("GuideBody", parent=base["BodyText"], spaceAfter=6, leading=14),
        "Caption": ParagraphStyle("GuideCaption", parent=base["BodyText"], fontSize=8,
                                   textColor=colors.grey, spaceAfter=10),
        "Meta": ParagraphStyle("GuideMeta", parent=base["BodyText"], fontSize=9,
                                textColor=colors.grey, spaceAfter=4),
    }


def _inline_markup(text):
    """Escapes text, then re-applies a small subset of Markdown as reportlab's
    own mini-markup (bold/italic/code) — Paragraph text is itself a
    restricted XML dialect, so raw user text must be escaped first or it
    could break parsing (or inject arbitrary markup)."""
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r'<font face="Courier">\1</font>', text)
    return text


def _markdown_flowables(text, styles):
    """A small, deliberately limited Markdown->flowables converter: headings,
    paragraphs, bullet lists, **bold**/*italic*/`code`. Coaching notes in
    this app are short freeform text, not full documents — no tables,
    nested lists, links, or code blocks."""
    flowables = []
    para_buf, list_buf = [], []

    def flush_para():
        if para_buf:
            flowables.append(Paragraph(_inline_markup(" ".join(para_buf)), styles["Body"]))
            para_buf.clear()

    def flush_list():
        if list_buf:
            flowables.append(ListFlowable(
                [ListItem(Paragraph(_inline_markup(t), styles["Body"])) for t in list_buf],
                bulletType="bullet", leftIndent=14))
            list_buf.clear()

    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            flush_para()
            flush_list()
            continue
        heading = re.match(r"^(#{1,3})\s+(.*)", line)
        if heading:
            flush_para()
            flush_list()
            flowables.append(Paragraph(_inline_markup(heading.group(2)),
                                        styles[f"H{len(heading.group(1))}"]))
            continue
        bullet = re.match(r"^[-*]\s+(.*)", line)
        if bullet:
            flush_para()
            list_buf.append(bullet.group(1))
            continue
        flush_list()
        para_buf.append(line)
    flush_para()
    flush_list()
    return flowables or [Paragraph("<i>No notes.</i>", styles["Body"])]


class _IconFetcher:
    """Fetches + caches rune/shard icon bytes for one export call (a matchup
    list commonly reuses the same keystone/shards across several pages)."""

    def __init__(self):
        self._cache = {}

    def _get(self, url):
        if url not in self._cache:
            try:
                resp = httpx.get(url, timeout=5.0)
                resp.raise_for_status()
                self._cache[url] = resp.content
            except httpx.HTTPError:
                self._cache[url] = None
        return self._cache[url]

    def rune_or_tree(self, icon_path):
        return self._get(RUNE_ICON_URL.format(icon_path)) if icon_path else None

    def shard(self, icon_path):
        return self._get(SHARD_ICON_URL.format(icon_path)) if icon_path else None


def _icon_image(data):
    if not data:
        return None
    try:
        return Image(io.BytesIO(data), width=ICON_PT, height=ICON_PT)
    except Exception:
        return None


def _rune_page_flowables(page, icons, styles):
    imgs = []

    def add(icon_bytes):
        img = _icon_image(icon_bytes)
        if img:
            imgs.append(img)

    add(icons.rune_or_tree(rune_data.RUNE_ICON.get(page.get("keystone"))))
    for name in page.get("primary_runes") or []:
        add(icons.rune_or_tree(rune_data.RUNE_ICON.get(name)))
    add(icons.rune_or_tree(rune_data.TREE_ICON.get(page.get("secondary_tree"))))
    for name in page.get("secondary_runes") or []:
        add(icons.rune_or_tree(rune_data.RUNE_ICON.get(name)))
    for name in page.get("shards") or []:
        add(icons.shard(rune_data.SHARD_ICON.get(name)))

    flowables = []
    if imgs:
        table = Table([imgs], hAlign="LEFT")
        table.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        flowables.append(table)

    primary = ", ".join(filter(None, [page.get("keystone"), *(page.get("primary_runes") or [])]))
    secondary = ", ".join(filter(None, [page.get("secondary_tree"), *(page.get("secondary_runes") or [])]))
    shards = ", ".join(filter(None, page.get("shards") or []))
    caption_bits = [b for b in (primary, secondary, shards and f"Shards: {shards}") if b]
    if page.get("label"):
        caption_bits.insert(0, f'"{page["label"]}"')
    flowables.append(Paragraph(_inline_markup(" — ".join(caption_bits)), styles["Caption"]))
    return flowables


def build_champion_guide_pdf(champion, general_notes, guide):
    """champion: display name string. general_notes: Markdown str.
    guide: {opp_champion: {notes, runes: [page, ...], patch_version}} as
    returned by db.get_matchup_notes. Matchups are ordered alphabetically —
    the "most-played first" ordering the UI uses depends on a separate
    stats query this module deliberately doesn't need."""
    styles = _styles()
    icons = _IconFetcher()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER, leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=18 * mm, bottomMargin=18 * mm, title=f"{champion} — Champ Guide")
    story = [Paragraph(f"{html.escape(champion)} — Champ Guide", styles["Title"]), Spacer(1, 4)]

    if general_notes and general_notes.strip():
        story.append(Paragraph("General notes", styles["H1"]))
        story.extend(_markdown_flowables(general_notes, styles))
        story.append(Spacer(1, 6))

    for opp_champion in sorted(guide):
        entry = guide[opp_champion]
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.lightgrey,
                                 spaceBefore=4, spaceAfter=8))
        story.append(Paragraph(f"vs {html.escape(opp_champion)}", styles["H2"]))
        if entry.get("patch_version"):
            story.append(Paragraph(f"Patch {html.escape(entry['patch_version'])}", styles["Meta"]))
        for page in entry.get("runes") or []:
            story.extend(_rune_page_flowables(page, icons, styles))
        if (entry.get("notes") or "").strip():
            story.extend(_markdown_flowables(entry["notes"], styles))
        else:
            story.append(Paragraph("<i>No notes.</i>", styles["Body"]))

    if len(story) == 2:  # just the title + spacer — nothing else was added
        story.append(Paragraph("No guide content recorded for this champion yet.", styles["Body"]))

    doc.build(story)
    return buf.getvalue()
