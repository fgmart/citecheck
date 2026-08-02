import re
import statistics
import sys
import fitz


REFERENCE_HEADING_RE = re.compile(
    r"^(?:(?:acknowledgments?|acknowledgements?)\s+)?(?:references|bibliography)$",
    re.I,
)
BRACKET_REFERENCE_START_RE = re.compile(r"^\[(\d{1,3})\]\s+")
NUMERIC_REFERENCE_START_RE = re.compile(r"^([1-9]\d{0,2})[.)]\s+")
REFERENCE_START_RE = re.compile(r"^(?:\[(\d{1,3})\]|([1-9]\d{0,2})[.)])\s+")
SECTION_STOP_RE = re.compile(
    r"^(abstract|introduction|conclusion|appendix|acknowledgments|data availability|funding)\b",
    re.I,
)
SECTION_BOUNDARY_MARKER = "\x00CITECHECK_SECTION_BOUNDARY\x00"
INLINE_REFERENCE_START_RE = re.compile(r"(?<!\S)(?:\[\d{1,3}\]|[1-9]\d{0,2}[.)])(?=\s+[\w\"'“])")
YEAR_RE = re.compile(r"\((?:19|20)\d{2}(?:[,;)])")


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
    text = re.sub(r"(\b(?:doi:\s*|https?://doi\.org/)?10\.)\s+(?=\d{4,9}/)", r"\1", text, flags=re.I)
    text = re.sub(r"(\b10\.\d{4,9}/)\s+(?=[-._;()/:A-Z0-9])", r"\1", text, flags=re.I)
    text = re.sub(r"(doi:\s*10\.\d{4,9}/\S+)\s+([A-Za-z0-9])", r"\1\2", text, flags=re.I)
    text = re.sub(r"(10\.\d{4,9}/\S*[-./])\s+([A-Za-z0-9])", r"\1\2", text, flags=re.I)

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
    if REFERENCE_HEADING_RE.match(text) or is_reference_start(text):
        return False

    letters = re.sub(r"[^A-Za-z]", "", text)
    if len(letters) < 4:
        return False
    if len(text) > 80 or len(text.split()) > 10:
        return False
    if y0 > page.rect.height * 0.2:
        return False

    block_center = (x0 + x1) / 2
    page_center = page.rect.width / 2
    if (
        abs(block_center - page_center) > page.rect.width * 0.12
        or (x1 - x0) > page.rect.width * 0.5
    ):
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
    for block in page.get_text("blocks"):
        text = normalize_text(block[4])
        if not text:
            continue
        x0, y0, x1, y1 = block[:4]
        blocks.append((x0, y0, x1, y1, text))

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


def lines_by_column(lines, page_width):
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
    for page_index, page in enumerate(doc):
        for line in ordered_lines(page):
            if REFERENCE_HEADING_RE.match(line[4]):
                return page_index, line
    return None, None


def build_unnumbered_reference_groups(doc):
    heading_page_index, heading_line = find_reference_heading(doc)
    if heading_page_index is None:
        return []

    reference_groups = []
    current_group = []

    for page_index in range(heading_page_index, len(doc)):
        page = doc[page_index]
        page_blocks = ordered_blocks(page)
        boundary_positions = [
            block[1] for block in page_blocks
            if page_index > heading_page_index and is_structural_section_heading(page, block)
        ]
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

            base_x = min(line[0] for line in column)
            for line in column:
                text = repair_line_wrapping(line[4])
                if not text or REFERENCE_HEADING_RE.match(text):
                    continue

                is_first_line_indent = line[0] <= base_x + 8
                if is_first_line_indent and current_group:
                    reference_groups.append(repair_line_wrapping(" ".join(current_group)))
                    current_group = [text]
                else:
                    current_group.append(text)

        if boundary_y is not None:
            break

    if current_group:
        reference_groups.append(repair_line_wrapping(" ".join(current_group)))

    return [
        group for group in reference_groups
        if YEAR_RE.search(group) and len(group.split()) >= 8
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
        document_references = build_reference_groups(all_blocks, heading_seen=True)
    if len(document_references) < 3:
        document_references = build_unnumbered_reference_groups(doc)
        unnumbered_references = True

    if document_references:
        groups = document_references if unnumbered_references else sort_reference_groups(document_references)
        return "\n\n".join(groups)

    text_parts = []
    for page in doc:
        text_parts.append(extract_page_text(page))
    return "\n\n".join(text_parts)


if __name__ == "__main__":
    print(extract_document_text(sys.argv[1]))
