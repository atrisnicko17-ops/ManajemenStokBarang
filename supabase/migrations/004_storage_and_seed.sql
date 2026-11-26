-- ============================================================================
-- 004_storage_and_seed.sql
-- GudangKu WMS — Private Storage Bucket (evidence-media) & RLS Policies
-- ============================================================================

-- Buat bucket privat evidence-media (maksimal 2 MB per file, hanya WebP/JPEG/PNG/PDF)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'evidence-media',
    'evidence-media',
    FALSE,
    2097152,
    ARRAY['image/webp', 'image/jpeg', 'image/png', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = 2097152,
    allowed_mime_types = ARRAY['image/webp', 'image/jpeg', 'image/png', 'application/pdf'];

-- Kebijakan Storage: Path objek wajib diawali `<tenant_id>/...`
-- Mendukung INSERT + SELECT + UPDATE untuk kebutuhan upload dan upsert bukti foto/TTD BAST
CREATE POLICY "evidence_media_select_tenant" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'evidence-media'
        AND (storage.foldername(name))[1] = (SELECT private.get_auth_tenant_id())::TEXT
    );

CREATE POLICY "evidence_media_insert_tenant" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'evidence-media'
        AND (storage.foldername(name))[1] = (SELECT private.get_auth_tenant_id())::TEXT
    );

CREATE POLICY "evidence_media_update_tenant" ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'evidence-media'
        AND (storage.foldername(name))[1] = (SELECT private.get_auth_tenant_id())::TEXT
    )
    WITH CHECK (
        bucket_id = 'evidence-media'
        AND (storage.foldername(name))[1] = (SELECT private.get_auth_tenant_id())::TEXT
    );
