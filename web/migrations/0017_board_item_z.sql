-- Stacking order on a board's canvas: a higher z sits on top. Boards load in z order, and the
-- client sends z with each placement, so the order survives a reload.
ALTER TABLE board_items ADD COLUMN z INTEGER NOT NULL DEFAULT 0;

-- Existing rows keep the order boards loaded in until now: websites, pages, images, then notes,
-- each in the order its list query returned.
UPDATE board_items SET z = o.z FROM (
  SELECT b.rowid AS rid, ROW_NUMBER() OVER (
    PARTITION BY b.collection_id
    ORDER BY CASE b.kind WHEN 'reference' THEN 0 WHEN 'page' THEN 1 WHEN 'image' THEN 2 ELSE 3 END,
      coalesce(r.created_at, pc.added_at, i.created_at) DESC,
      p.id,
      CASE WHEN b.kind = 'note' THEN b.item_id END,
      b.item_id DESC,
      b.page_path
  ) AS z
  FROM board_items b
  LEFT JOIN refs r ON b.kind = 'reference' AND r.id = b.item_id
  LEFT JOIN page_collections pc ON b.kind = 'page' AND pc.collection_id = b.collection_id AND pc.reference_id = b.item_id AND pc.page_path = b.page_path
  LEFT JOIN pages p ON b.kind = 'page' AND p.reference_id = b.item_id AND p.path = b.page_path
  LEFT JOIN images i ON b.kind = 'image' AND i.id = b.item_id
) o WHERE board_items.rowid = o.rid;
