import re
import statistics
import sys
import pymupdf as fitz


REFERENCE_HEADING_RE = re.compile(
    r"^(?:(?:acknowledgments?|acknowledgements?)\s+)?(?:references|bibliography)$",
    re.I,
)
BRACKET_REFERENCE_START_RE = re.compile(r"^\[(\d{1,3})\]\s+")
NUMERIC_REFERENCE_START_RE = re.compile(r"^([1-9]\d{0,2})[.)]\s+")
REFERENCE_START_RE = re.compile(r"^(?:\[(\d{1,3})\]|([1-9]\d{0,2})[.)])\s+")
SECTION_STOP_RE = re.compile(
    r"^(?:(?:[A-Z]|\d+(?:\.\d+)*)\s+)?"
    r"(abstract|introduction|conclusion|appendix|acknowledgments|data availability|funding)\b",
    re.I,
)
LETTERED_SECTION_HEADING_RE = re.compile(r"^[A-Z]\s+[A-Z][A-Za-z0-9]")
PAGE_BOILERPLATE_RE = re.compile(r"^(?:Manuscript submitted to ACM|Anon\.)$", re.I)
SECTION_BOUNDARY_MARKER = "\x00CITECHECK_SECTION_BOUNDARY\x00"
INLINE_REFERENCE_START_RE = re.compile(r"(?<!\S)(?:\[\d{1,3}\]|[1-9]\d{0,2}[.)])(?=\s+[\w\"'“])")
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}[a-z]?\b", re.I)
DOI_AT_TEXT_END_RE = re.compile(r"(?:doi:\s*|https?://doi\.org/)?10\.\d{4,9}/\S+$", re.I)
AUTHOR_DATE_START_RE = re.compile(
    r"^.{2,320}?\((?:19|20)\d{2}(?:[a-z]|,\s*[^)]*)?\)\.\s+",
    re.I,
)


def normalize_text(text):
    return re.sub(r"\s+", " ", text or "").strip()


def is_reference_start(text):
    return bool(REFERENCE_START_RE.match(text))


def is_reference_start_for_style(text, marker_style):
    if marker_style == "bracket":
        return bool(BRACKET_REFERENCE_START_RE.match(text))
    if marker_style == "numeric":
        return bool(NUMERIC_REFERENCE_START_RE.match(text))
    return is_reference_start(text)


def reference_number(text):
    match = BRACKET_REFERENCE_START_RE.match(text)
    if match:
        return int(match.group(1))
    match = NUMERIC_REFERENCE_START_RE.match(text)
    if not match:
        return None
    return int(match.group(1))


def repair_line_wrapping(text):
    # Some TeX-era PDF fonts expose isolated mojibake code points through
    # PyMuPDF. Repair only the unambiguous forms observed in citation fields.
    text = re.sub(r"(?<=\d)â(?=\d)", "–", text)
    text = text.replace("Ãº", "ú")

    # PDF line extraction can insert whitespace at any visual line break. Repair
    # unambiguous DOI boundaries before applying the more general suffix repair.
    text = re.sub(r"(https?://doi\.org/)\s+(?=10\.)", r"\1", text, flags=re.I)
    text = re.sub(r"(\b(?:doi:\s*|https?://doi\.org/)?10\.)\s+(?=\d{4,9}/)", r"\1", text, flags=re.I)
    text = re.sub(r"(\b10\.\d{4,9}/)\s+(?=[-._;()/:A-Z0-9])", r"\1", text, flags=re.I)
    text = re.sub(
        r"(10\.\d{4,9}/\S*[-./])\s+(?!(?:URL\b|https?://|doi\b))([A-Za-z0-9])",
        r"\1\2",
        text,
        flags=re.I,
    )

    def repair_hyphen(match):
        left, right = match.group(1), match.group(2)
        if left.isupper() and len(left) > 1:
            return f"{left}-{right}"
        return f"{left}{right}"

    text = re.sub(r"([A-Za-z]{1,})-\s+([a-z]{2,})", repair_hyphen, text)
    text = re.sub(r"([A-Za-z]{2,})-\s+([A-Z][a-z]+)\b", r"\1-\2", text)
    return normalize_text(text)


def split_inline_references(text):
    matches = list(INLINE_REFERENCE_START_RE.finditer(text))
    if not matches:
        return [text]

    chunks = []
    if matches[0].start() > 0:
        chunks.append(text[:matches[0].start()].strip())

    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def has_inline_reference_start(text):
    return bool(INLINE_REFERENCE_START_RE.search(text))


def is_structural_section_heading(page, block):
    x0, y0, x1, _, text = block
    if REFERENCE_HEADING_RE.match(text) or is_reference_start(text) or AUTHOR_DATE_START_RE.match(text):
        return False

    is_lettered_heading = bool(LETTERED_SECTION_HEADING_RE.match(text))
    letters = re.sub(r"[^A-Za-z]", "", text)
    if len(letters) < 4:
        return False
    if len(text) > 80 or len(text.split()) > 10:
        return False
    if y0 > page.rect.height * 0.2 and not is_lettered_heading:
        return False

    block_center = (x0 + x1) / 2
    page_center = page.rect.width / 2
    is_centered = (
        abs(block_center - page_center) <= page.rect.width * 0.12
        and (x1 - x0) <= page.rect.width * 0.5
    )
    if not is_centered and not is_lettered_heading:
        return False

    all_sizes = []
    block_sizes = []
    block_fonts = []
    for styled_block in page.get_text("dict").get("blocks", []):
        for line in styled_block.get("lines", []):
            line_x0, line_y0, line_x1, line_y1 = line["bbox"]
            overlaps_block = not (
                line_x1 < x0 or line_x0 > x1 or line_y1 < y0 or line_y0 > block[3]
            )
            for span in line.get("spans", []):
                size = float(span.get("size", 0))
                if size > 0:
                    all_sizes.append(size)
                    if overlaps_block:
                        block_sizes.append(size)
                        block_fonts.append(span.get("font", "").lower())

    typical_size = statistics.median(all_sizes) if all_sizes else 0
    is_larger = bool(block_sizes and typical_size and max(block_sizes) >= typical_size * 1.12)
    is_emphasized = any("bold" in font or "medi" in font or "semi" in font for font in block_fonts)
    return text == text.upper() or is_larger or is_emphasized


def cluster_columns(blocks, page_width):
    reference_blocks = [block for block in blocks if is_reference_start(block[4]) or has_inline_reference_start(block[4])]
    if len(reference_blocks) < 2:
        return [sorted(blocks, key=lambda b: (b[1], b[0]))]

    starts = sorted(block[0] for block in reference_blocks)
    gaps = [(starts[index + 1] - starts[index], index) for index in range(len(starts) - 1)]
    largest_gap, gap_index = max(gaps, default=(0, 0))

    if largest_gap < page_width * 0.2:
        return [sorted(blocks, key=lambda b: (b[1], b[0]))]

    split_x = (starts[gap_index] + starts[gap_index + 1]) / 2
    left = [block for block in blocks if block[0] < split_x]
    right = [block for block in blocks if block[0] >= split_x]

    columns = []
    for column in (left, right):
        if column:
            columns.append(sorted(column, key=lambda b: (b[1], b[0])))
    return columns


def ordered_blocks(page):
    blocks = []
    numeric_continuation_candidates = []
    for raw_block in page.get_text("dict").get("blocks", []):
        retained_lines = []
        has_top_page_number = False
        for line in raw_block.get("lines", []):
            line_text = normalize_text("".join(span.get("text", "") for span in line.get("spans", [])))
            if not line_text:
                continue
            if re.fullmatch(r"\d{1,4}", line_text):
                if (
                    line["bbox"][1] < page.rect.height * 0.15
                    and line["bbox"][0] > page.rect.width * 0.75
                ):
                    has_top_page_number = True
                elif (
                    retained_lines
                    and line["bbox"][0] >= page.rect.width * 0.1
                    and line["bbox"][1] - retained_lines[-1][3] <= page.rect.height * 0.02
                    and DOI_AT_TEXT_END_RE.search(retained_lines[-1][4])
                ):
                    previous = retained_lines[-1]
                    retained_lines[-1] = (
                        previous[0], previous[1], max(previous[2], line["bbox"][2]),
                        line["bbox"][3], f"{previous[4]}{line_text}",
                    )
                elif (
                    line["bbox"][0] >= page.rect.width * 0.1
                    and page.rect.height * 0.15 <= line["bbox"][1] <= page.rect.height * 0.9
                ):
                    numeric_continuation_candidates.append((*line["bbox"], line_text))
                continue
            if (
                PAGE_BOILERPLATE_RE.fullmatch(line_text)
                and (
                    line["bbox"][1] < page.rect.height * 0.15
                    or line["bbox"][1] > page.rect.height * 0.8
                )
            ):
                continue
            retained_lines.append((*line["bbox"], line_text))

        # Some proceedings templates place the running title and page number in
        # one PDF block. Once the numeric line is removed, the title would
        # otherwise look like bibliography continuation text.
        if not retained_lines or has_top_page_number:
            continue
        x0 = min(line[0] for line in retained_lines)
        y0 = min(line[1] for line in retained_lines)
        x1 = max(line[2] for line in retained_lines)
        y1 = max(line[3] for line in retained_lines)
        text = normalize_text(" ".join(line[4] for line in retained_lines))
        blocks.append((x0, y0, x1, y1, text))

    # A wrapped DOI suffix may be emitted as its own numeric PDF block. Join it
    # only when it is spatially adjacent to a block that ends in a DOI; ordinary
    # manuscript line numbers live in the margin and never satisfy this test.
    for numeric_block in numeric_continuation_candidates:
        nearby = [
            (index, block) for index, block in enumerate(blocks)
            if DOI_AT_TEXT_END_RE.search(block[4])
            and 0 <= numeric_block[1] - block[3] <= page.rect.height * 0.02
            and block[0] - 2 <= numeric_block[0] <= block[0] + page.rect.width * 0.2
        ]
        if not nearby:
            continue
        index, previous = min(nearby, key=lambda item: numeric_block[1] - item[1][3])
        blocks[index] = (
            previous[0], previous[1], max(previous[2], numeric_block[2]),
            numeric_block[3], f"{previous[4]}{numeric_block[4]}",
        )

    if not blocks:
        return []

    blocks = [
        block for block in blocks
        if not (
            (block[1] < page.rect.height * 0.06 and not REFERENCE_HEADING_RE.match(block[4]) and not has_inline_reference_start(block[4]))
            or block[1] > page.rect.height * 0.94
        )
    ]

    reference_heading = next((block for block in blocks if REFERENCE_HEADING_RE.match(block[4])), None)
    margin = 24
    right_column_x0 = page.rect.width / 2 - margin
    if reference_heading and reference_heading[0] >= right_column_x0:
        heading_y0 = reference_heading[1]
        blocks = [
            block for block in blocks
            if block[1] < heading_y0 or block[0] >= right_column_x0
        ]

    ordered = []
    for column in cluster_columns(blocks, page.rect.width):
        ordered.extend(column)
    return ordered


def ordered_lines(page):
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = normalize_text("".join(span.get("text", "") for span in line.get("spans", [])))
            if not text:
                continue
            x0, y0, x1, y1 = line["bbox"]
            if re.fullmatch(r"\d{1,4}", text):
                continue
            if (
                (y0 < page.rect.height * 0.06 and not REFERENCE_HEADING_RE.match(text))
                or y0 > page.rect.height * 0.94
            ):
                continue
            lines.append((x0, y0, x1, y1, text))
    return lines


def merge_same_baseline_fragments(lines, page_width):
    if not lines:
        return []

    baseline_tolerance = 1.5
    maximum_fragment_gap = page_width * 0.03
    baseline_groups = []
    for line in sorted(lines, key=lambda item: (item[1], item[0])):
        if baseline_groups and abs(line[1] - baseline_groups[-1][0][1]) <= baseline_tolerance:
            baseline_groups[-1].append(line)
        else:
            baseline_groups.append([line])

    merged = []
    for baseline_group in baseline_groups:
        current = None
        for line in sorted(baseline_group, key=lambda item: item[0]):
            if current is not None and line[0] - current[2] <= maximum_fragment_gap:
                current = (
                    min(current[0], line[0]),
                    min(current[1], line[1]),
                    max(current[2], line[2]),
                    max(current[3], line[3]),
                    normalize_text(f"{current[4]} {line[4]}"),
                )
            else:
                if current is not None:
                    merged.append(current)
                current = line
        if current is not None:
            merged.append(current)
    return merged


def lines_by_column(lines, page_width):
    lines = merge_same_baseline_fragments(lines, page_width)
    midpoint = page_width / 2
    left = [line for line in lines if line[0] < midpoint]
    right = [line for line in lines if line[0] >= midpoint]
    columns = []
    for column in (left, right):
        if column:
            columns.append(sorted(column, key=lambda line: (line[1], line[0])))
    return columns


def sort_reference_groups(reference_groups):
    reference_groups = merge_continuation_groups(reference_groups)
    numbered = []
    for group in reference_groups:
        number = reference_number(group)
        if number is None:
            return reference_groups
        numbered.append((number, group))

    if len(numbered) < 3:
        return reference_groups

    numbers = [number for number, _ in numbered]
    unique_numbers = set(numbers)
    if len(unique_numbers) != len(numbers):
        return reference_groups

    expected = set(range(min(numbers), max(numbers) + 1))
    coverage = len(unique_numbers & expected) / max(len(expected), 1)
    if coverage < 0.8:
        return reference_groups

    return [group for _, group in sorted(numbered, key=lambda item: item[0])]


def merge_continuation_groups(reference_groups):
    merged = []
    for group in reference_groups:
        group = repair_line_wrapping(group)
        if not group:
            continue
        if reference_number(group) is None and merged:
            merged[-1] = repair_line_wrapping(f"{merged[-1]} {group}")
        else:
            merged.append(group)
    return merged


def build_reference_groups(blocks, heading_seen=False):
    reference_groups = []
    current_group = []
    in_references = heading_seen
    marker_style = infer_marker_style(blocks)

    for _, _, _, _, text in blocks:
        normalized = repair_line_wrapping(text)
        if not normalized:
            continue

        if not in_references:
            if REFERENCE_HEADING_RE.match(normalized):
                in_references = True
            continue

        if normalized == SECTION_BOUNDARY_MARKER:
            break

        if SECTION_STOP_RE.match(normalized):
            break

        for chunk in split_inline_references(normalized):
            if not chunk:
                continue

            if is_reference_start_for_style(chunk, marker_style):
                if current_group:
                    reference_groups.append(repair_line_wrapping(" ".join(current_group)))
                current_group = [chunk]
            elif current_group:
                current_group.append(chunk)

    if current_group:
        reference_groups.append(repair_line_wrapping(" ".join(current_group)))

    return reference_groups


def find_reference_heading(doc):
    candidates = []
    for page_index, page in enumerate(doc):
        for line in ordered_lines(page):
            if REFERENCE_HEADING_RE.match(line[4]):
                candidates.append((page_index, line))

    if not candidates:
        return None, None

    def candidate_score(candidate):
        page_index, heading_line = candidate
        score = 0
        inspected = 0

        # A real bibliography heading is followed immediately by a dense run of
        # author-date entries. A table-of-contents entry with the same text is
        # not. Validate the local content instead of accepting the first match.
        for nearby_page_index in range(page_index, min(len(doc), page_index + 2)):
            nearby_page = doc[nearby_page_index]
            for nearby_line in sorted(ordered_lines(nearby_page), key=lambda item: (item[1], item[0])):
                if nearby_page_index == page_index and nearby_line[1] <= heading_line[1]:
                    continue
                text = repair_line_wrapping(nearby_line[4])
                if not text or REFERENCE_HEADING_RE.match(text):
                    continue
                inspected += 1
                if AUTHOR_DATE_START_RE.match(text):
                    score += 8
                elif YEAR_RE.search(text):
                    score += 1
                if re.search(r"(?:doi\.org/10\.|\bdoi:\s*10\.)", text, re.I):
                    score += 2
                if inspected >= 40:
                    break
            if inspected >= 40:
                break

        if heading_line[1] <= doc[page_index].rect.height * 0.2:
            score += 3
        return score

    return max(candidates, key=candidate_score)


def split_unnumbered_column(column):
    if not column:
        return []

    gaps = [
        column[index + 1][1] - column[index][1]
        for index in range(len(column) - 1)
        if column[index + 1][1] > column[index][1]
    ]
    ordinary_gaps = [gap for gap in gaps if gap <= statistics.median(gaps) * 1.25] if gaps else []
    line_gap = statistics.median(ordinary_gaps or gaps) if gaps else 0
    paragraph_gap = line_gap * 1.45 if line_gap else float("inf")

    groups = []
    current = []
    previous = None
    for line in column:
        text = repair_line_wrapping(line[4])
        if not text or REFERENCE_HEADING_RE.match(text):
            continue
        gap = line[1] - previous[1] if previous is not None else 0
        if current and gap > paragraph_gap:
            groups.append(repair_line_wrapping(" ".join(current)))
            current = [text]
        else:
            current.append(text)
        previous = line

    if current:
        groups.append(repair_line_wrapping(" ".join(current)))
    return groups


def looks_like_unnumbered_reference(text):
    normalized = repair_line_wrapping(text)
    if len(normalized.split()) < 5 or not YEAR_RE.search(normalized):
        return False

    before_year = normalized[:YEAR_RE.search(normalized).start()]
    has_authored_sentence = bool(re.search(r"[A-Za-z][.!?]\s+[A-Z]", before_year))
    has_publication_signal = bool(re.search(
        r"\b(?:doi|arxiv|isbn|journal|proceedings?|conference|transactions?|press|springer|"
        r"volume|vol\.?|pp?\.?|pages?|publisher)\b|https?://|\d+\s*\([^)]*\)\s*:\s*\d+",
        normalized,
        re.I,
    ))
    return has_authored_sentence or has_publication_signal


def looks_like_reference_collection(reference_groups):
    if len(reference_groups) < 3:
        return False
    viable_count = sum(looks_like_unnumbered_reference(group) for group in reference_groups)
    return viable_count / len(reference_groups) >= 0.6


def build_unnumbered_reference_groups(doc):
    heading_page_index, heading_line = find_reference_heading(doc)
    if heading_page_index is None:
        return []

    reference_groups = []

    for page_index in range(heading_page_index, len(doc)):
        page = doc[page_index]
        page_blocks = ordered_blocks(page)
        boundary_positions = [
            block[1] for block in page_blocks
            if page_index > heading_page_index and is_structural_section_heading(page, block)
        ]
        boundary_positions.extend(
            line[1] for line in ordered_lines(page)
            if page_index > heading_page_index and SECTION_STOP_RE.match(line[4])
        )
        boundary_y = min(boundary_positions) if boundary_positions else None
        columns = lines_by_column(ordered_lines(page), page.rect.width)

        for column in columns:
            if boundary_y is not None:
                column = [line for line in column if line[1] < boundary_y]
            if page_index == heading_page_index:
                heading_x0, heading_y0 = heading_line[0], heading_line[1]
                same_column = abs(column[0][0] - heading_x0) < page.rect.width * 0.2
                if not same_column:
                    continue
                column = [line for line in column if line[1] > heading_y0 and not REFERENCE_HEADING_RE.match(line[4])]

            if not column:
                continue

            page_groups = split_unnumbered_column(column)
            for group in page_groups:
                if reference_groups and not looks_like_unnumbered_reference(group):
                    reference_groups[-1] = repair_line_wrapping(f"{reference_groups[-1]} {group}")
                else:
                    reference_groups.append(group)

        if boundary_y is not None:
            break

    return [
        group for group in reference_groups
        if looks_like_unnumbered_reference(group)
    ]


def infer_marker_style(blocks):
    bracket_count = 0
    numeric_count = 0
    for _, _, _, _, text in blocks:
        for chunk in split_inline_references(repair_line_wrapping(text)):
            if BRACKET_REFERENCE_START_RE.match(chunk):
                bracket_count += 1
            elif NUMERIC_REFERENCE_START_RE.match(chunk):
                numeric_count += 1

    if bracket_count >= 2:
        return "bracket"
    if numeric_count >= 2:
        return "numeric"
    return "any"


def extract_page_text(page):
    blocks = ordered_blocks(page)

    if not blocks:
        return page.get_text("text") or ""

    reference_groups = build_reference_groups(blocks)

    if reference_groups:
        return "\n\n".join(sort_reference_groups(reference_groups))

    lines = []
    for _, _, _, _, text in blocks:
        for line in text.splitlines():
            line = line.strip()
            if line:
                lines.append(line)

    numbered = []
    others = []
    for line in lines:
        if re.match(r"^\[(\d+)\]", line) or re.match(r"^(\d+)[.)]", line):
            numbered.append(line)
        else:
            others.append(line)

    if numbered and len(numbered) >= 3:
        ordered = numbered + others
    else:
        ordered = lines

    return "\n".join(ordered)


def extract_document_text(pdf_path):
    doc = fitz.open(pdf_path)
    all_blocks = []
    for page in doc:
        page_blocks = ordered_blocks(page)
        for block in page_blocks:
            if is_structural_section_heading(page, block):
                all_blocks.append((block[0], block[1], block[2], block[3], SECTION_BOUNDARY_MARKER))
            all_blocks.append(block)

    unnumbered_references = False
    document_references = build_reference_groups(all_blocks)
    if len(document_references) < 3:
        document_references = build_unnumbered_reference_groups(doc)
        unnumbered_references = True
    if len(document_references) < 3 and find_reference_heading(doc)[0] is None:
        headerless_references = build_reference_groups(all_blocks, heading_seen=True)
        if looks_like_reference_collection(headerless_references):
            document_references = headerless_references
            unnumbered_references = False

    if document_references:
        groups = document_references if unnumbered_references else sort_reference_groups(document_references)
        return "\n\n".join(groups)

    text_parts = []
    for page in doc:
        text_parts.append(extract_page_text(page))
    return "\n\n".join(text_parts)


if __name__ == "__main__":
    print(extract_document_text(sys.argv[1]))
