import re
import sys
import fitz


def extract_page_text(page):
    blocks = []
    for block in page.get_text("blocks"):
        text = (block[4] or "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = block[:4]
        blocks.append((x0, y0, x1, y1, text))

    if not blocks:
        return page.get_text("text") or ""

    blocks.sort(key=lambda b: (b[1], b[0]))
    lines = []
    for _, _, _, _, text in blocks:
        for line in text.splitlines():
            line = line.strip()
            if line:
                lines.append(line)

    # Re-rank lines when bibliography numbering suggests a reference list ordering issue.
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
