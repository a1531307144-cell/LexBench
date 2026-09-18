_DIGITS = {
    "零": 0, "〇": 0,
    "一": 1, "二": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
_UNITS = {"十": 10, "百": 100, "千": 1000}


def cn2num(s: str):
    """中文数字（≤9999，含零/〇占位）或阿拉伯数字字符串转 int；无法解析返回 None。"""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    total = 0
    current = 0
    for ch in s:
        if ch in _DIGITS:
            current = _DIGITS[ch]
        elif ch in _UNITS:
            if current == 0:
                current = 1  # "十" 独立成词表示 10
            total += current * _UNITS[ch]
            current = 0
        else:
            return None
    return total + current
