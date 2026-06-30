import re
import sys
import fitz


def normalize_text(text):
    return re.sub(r"\s+", " ", text or "").strip()


def is_reference_start(text):
    return bool(re.match(r"^\[(\d+)\]", text) or re.match(r"^(\d+)[.)]", text))


def extract_page_text(page):
    blocks = []
    for block in page.get_text("blocks"):
        text = normalize_text(block[4])
        if not text:
            continue
        x0, y0, x1, y1 = block[:4]
        blocks.append((x0, y0, x1, y1, text))

    if not blocks:
        return page.get_text("text") or ""

    blocks.sort(key=lambda b: (b[1], b[0]))

    heading_found = False
    reference_groups = []
    current_group = []
    previous_bottom = None

    for _, y0, _, y1, text in blocks:
        normalized = normalize_text(text)
        if not normalized:
            continue

        if not heading_found:
            if re.match(r"^(references|bibliography)$", normalized.lower()):
                heading_found = True
            continue

        if is_reference_start(normalized):
            if current_group:
                reference_groups.append(" ".join(current_group))
            current_group = [normalized]
            previous_bottom = y1
            continue

        if current_group:
            gap = y0 - (previous_bottom or y0)
            if gap <= 18:
                current_group.append(normalized)
                previous_bottom = y1
                continue

        if current_group:
            reference_groups.append(" ".join(current_group))
        current_group = [normalized]
        previous_bottom = y1

    if current_group:
        reference_groups.append(" ".join(current_group))

    if reference_groups:
        return "\n\n".join(reference_groups)

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


pdf_path = sys.argv[1]
doc = fitz.open(pdf_path)
text_parts = []
for page in doc:
    text_parts.append(extract_page_text(page))
print("\n\n".join(text_parts))
