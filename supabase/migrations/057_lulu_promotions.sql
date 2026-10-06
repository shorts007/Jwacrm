-- ============================================================
-- 057_lulu_promotions.sql — image promotions (PRD §41 "New Offer")
--
-- A promotion is a lulu_campaigns row of type NEW_OFFER with:
--   promo_image_url   public image shown as the message header (changes per promotion
--                     without a new Meta template — the image is supplied at send time)
--   promo_text_ar/en  the promotion text inserted into the approved promo template
--   promo_valid_until last day the promotion is sent / shown as "valid until"
--   rule_params.audience  who receives it (lifecycle, price behaviour, stores, VIP, orders …)
-- Bucket `lulu-promos`: public read (Meta fetches the image), account-scoped writes.
-- Idempotent.
-- ============================================================
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS promo_image_url   text;
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS promo_text_ar     text;
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS promo_text_en     text;
ALTER TABLE lulu_campaigns ADD COLUMN IF NOT EXISTS promo_valid_until date;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('lulu-promos', 'lulu-promos', TRUE, 5242880, ARRAY['image/png', 'image/jpeg'])  -- WhatsApp image limit 5 MB
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "LuLu promo images are publicly readable" ON storage.objects;
CREATE POLICY "LuLu promo images are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'lulu-promos');

DROP POLICY IF EXISTS "Members can upload LuLu promo images" ON storage.objects;
CREATE POLICY "Members can upload LuLu promo images"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'lulu-promos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete LuLu promo images" ON storage.objects;
CREATE POLICY "Members can delete LuLu promo images"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'lulu-promos'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
