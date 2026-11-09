-- Per-item look on a board's canvas (rotation, opacity, corner radius, blur, crop, mask, outline, flip,
-- hidden, locked), as the JSON object BoardItemStyle. NULL is the plain default look.
ALTER TABLE board_items ADD COLUMN style_json TEXT;
