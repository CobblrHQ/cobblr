export interface SewingPattern {
    sizes: string[];
    supplies: {
        text: string;
        quantity: number | null;
        unit: string | null;
    }[];
}
export function readSewingPattern(text: string): SewingPattern | null {
    const lines = text.slice(0, 200000).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!/\b(sewing|seam allowance|fabric requirements|presser foot|dressmaking)\b/i.test(text))
        return null;
    const sizes = [...new Set(lines.filter(l => /^sizes?\b/i.test(l)).flatMap(l => (l.replace(/^sizes?\s*:?[ \t]*/i, "").match(/\b(?:[2-6]?XL|XS|XXS|S|M|L|\d{1,2}(?:\s*[-–]\s*\d{1,2})?)\b/gi) ?? [])))].slice(0, 40);
    const supplies = lines.filter(l => l.length <= 500 && /\b(fabric|lining|interfacing|thread|zipper|zip|elastic|buttons?|sewing needle)\b/i.test(l) && !/\b(sew|stitch|attach|insert|cut out|step)\b/i.test(l)).slice(0, 50).map(line => {
        const count = line.match(/^\s*(\d+)\s*(?:x\s*)?(?:buttons?|zippers?|sewing needles?)\b/i), length = line.match(/\b(\d+(?:[.,]\d+)?)\s*(m|metres?|meters?|yards?|yd|cm|mm)\b/i);
        const quantity = count ? Number(count[1]) : length ? Number(length[1]!.replace(",", ".")) : null;
        const raw = length?.[2]?.toLowerCase();
        const unit = count ? "pieces" : raw ? /^(m|metres?|meters?)$/.test(raw) ? "m" : /^(yards?|yd)$/.test(raw) ? "yd" : raw : null;
        return { text: line, quantity, unit };
    });
    return sizes.length || supplies.length ? { sizes, supplies } : null;
}
