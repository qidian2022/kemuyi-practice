-- Independent practice-progress storage. Existing application tables and Auth settings are untouched.
BEGIN;

CREATE OR REPLACE FUNCTION public.kemuyi_valid_ids(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_value) > 5000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) AS item(value)
    WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[1-9][0-9]{0,5}$') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_value) AS item(value)
    WHERE value::integer > 100000) THEN RETURN false; END IF;
  RETURN (SELECT count(*) = count(DISTINCT value) FROM jsonb_array_elements(p_value) AS item(value));
END;
$$;

CREATE OR REPLACE FUNCTION public.kemuyi_valid_answers(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_each(p_value)) > 5000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_value) AS item(key, value)
    WHERE key !~ '^[1-9][0-9]{0,5}$' OR jsonb_typeof(value) <> 'string'
      OR value #>> '{}' NOT IN ('A', 'B', 'C', 'D')) THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_each(p_value) AS item(key, value) WHERE key::integer > 100000);
END;
$$;

CREATE OR REPLACE FUNCTION public.kemuyi_valid_bank(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR NOT public.kemuyi_valid_ids(p_value->'order') THEN RETURN false; END IF;
  IF jsonb_typeof(p_value->'index') IS DISTINCT FROM 'number' OR (p_value->>'index') !~ '^[0-9]{1,5}$' THEN RETURN false; END IF;
  RETURN (p_value->>'index')::integer <= jsonb_array_length(p_value->'order');
END;
$$;

CREATE OR REPLACE FUNCTION public.kemuyi_valid_progress(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR p_value->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN false; END IF;
  IF NOT public.kemuyi_valid_answers(p_value->'answers') OR NOT public.kemuyi_valid_ids(p_value->'favorites') THEN RETURN false; END IF;
  IF jsonb_typeof(p_value->'page') IS DISTINCT FROM 'string' OR p_value->>'page' NOT IN ('full', 'compact', 'favorites') THEN RETURN false; END IF;
  IF NOT public.kemuyi_valid_bank(p_value->'full') OR NOT public.kemuyi_valid_bank(p_value->'compact') THEN RETURN false; END IF;
  IF jsonb_typeof(p_value->'favoriteIndex') IS DISTINCT FROM 'number' OR (p_value->>'favoriteIndex') !~ '^[0-9]{1,5}$' THEN RETURN false; END IF;
  IF (p_value->>'favoriteIndex')::integer > jsonb_array_length(p_value->'favorites') THEN RETURN false; END IF;
  IF NOT (p_value ? 'favoritePractice') THEN RETURN false; END IF;
  IF p_value->'favoritePractice' <> 'null'::jsonb AND
    (NOT public.kemuyi_valid_bank(p_value->'favoritePractice') OR NOT public.kemuyi_valid_answers(p_value->'favoritePractice'->'answers')) THEN RETURN false; END IF;
  RETURN octet_length(p_value::text) <= 256000;
END;
$$;

CREATE TABLE IF NOT EXISTS public.kemuyi_progress (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0 AND version <= 9007199254740991),
  data jsonb NOT NULL CHECK (public.kemuyi_valid_progress(data)),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kemuyi_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kemuyi_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kemuyi_progress TO authenticated;
DROP POLICY IF EXISTS kemuyi_progress_read_own ON public.kemuyi_progress;
CREATE POLICY kemuyi_progress_read_own ON public.kemuyi_progress
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.kemuyi_save_progress(p_user_id uuid, p_expected_version bigint, p_data jsonb)
RETURNS TABLE(version bigint, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'kemuyi_account_mismatch';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_expected_version >= 9007199254740991 OR NOT public.kemuyi_valid_progress(p_data) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'kemuyi_invalid_progress';
  END IF;
  IF p_expected_version = 0 THEN
    RETURN QUERY INSERT INTO public.kemuyi_progress AS target(user_id, version, data, updated_at)
      VALUES (p_user_id, 1, p_data, now()) ON CONFLICT (user_id) DO NOTHING
      RETURNING target.version, target.updated_at;
  ELSE
    RETURN QUERY UPDATE public.kemuyi_progress AS target
      SET version = target.version + 1, data = p_data, updated_at = now()
      WHERE target.user_id = p_user_id AND target.version = p_expected_version
      RETURNING target.version, target.updated_at;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'kemuyi_version_conflict';
  END IF;
END;
$$;

-- Browser clients can read only their own row. Writes go through the CAS function.
REVOKE ALL ON FUNCTION public.kemuyi_valid_ids(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kemuyi_valid_answers(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kemuyi_valid_bank(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kemuyi_valid_progress(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kemuyi_save_progress(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kemuyi_save_progress(uuid, bigint, jsonb) TO authenticated;

COMMIT;
