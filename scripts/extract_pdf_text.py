import re
import sys
import fitz


REFERENCE_HEADING_RE = re.compile(r"^(references|bibliography)$", re.I)
BRACKET_REFERENCE_START_RE = re.compile(r"^\[(\d{1,3})\]\s+")
NUMERIC_REFERENCE_START_RE = re.compile(r"^([1-9]\d{0,2})[.)]\s+")
REFERENCE_START_RE = re.compile(r"^(?:\[(\d{1,3})\]|([1-9]\d{0,2})[.)])\s+")
SECTION_STOP_RE = re.compile(
    r"^(abstract|introduction|conclusion|appendix|acknowledgments|data availability|funding)\b",
    re.I,
)
INLINE_REFERENCE_START_RE = re.compile(r"(?<!\S)(?:\[\d{1,3}\]|[1-9]\d{0,2}[.)])(?=\s+[\w\"'“])")


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
    text = re.sub(r"(doi:\s*10\.\d{4,9}/\S+)\s+([A-Za-z0-9])", r"\1\2", text, flags=re.I)
    text = re.sub(r"(10\.\d{4,9}/\S*[-./])\s+([A-Za-z0-9])", r"\1\2", text, flags=re.I)

    def repair_hyphen(match):
        left, right = match.group(1), match.group(2)
        if left.isupper() and len(left) > 1:
            return f"{left}-{right}"
        return f"{left}{right}"

    text = re.sub(r"([A-Za-z]{1,})-\s+([a-z]{2,})", repair_hyphen, text)
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
            (block[1] < page.rect.height * 0.1 and not REFERENCE_HEADING_RE.match(block[4]) and not has_inline_reference_start(block[4]))
            or block[1] > page.rect.height * 0.94
        )
    ]

    reference_heading = next((block for block in blocks if REFERENCE_HEADING_RE.match(block[4])), None)
    if reference_heading and reference_heading[0] > page.rect.width * 0.35:
        heading_x0, heading_y0 = reference_heading[0], reference_heading[1]
        margin = 24
        blocks = [
            block for block in blocks
            if block[1] < heading_y0 or block[0] >= heading_x0 - margin
        ]

    ordered = []
    for column in cluster_columns(blocks, page.rect.width):
        ordered.extend(column)
    return ordered


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
        all_blocks.extend(ordered_blocks(page))

    document_references = build_reference_groups(all_blocks)
    if len(document_references) < 3:
        document_references = build_reference_groups(all_blocks, heading_seen=True)

    if document_references:
        return "\n\n".join(sort_reference_groups(document_references))

    text_parts = []
    for page in doc:
        text_parts.append(extract_page_text(page))
    return "\n\n".join(text_parts)


if __name__ == "__main__":
    print(extract_document_text(sys.argv[1]))
