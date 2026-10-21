CREATE TABLE "cg_contacts" (
	"contact_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"title" text,
	"company" text,
	"company_domain" text,
	"phone" text,
	"linkedin_url" text,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"sighting_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cg_contributions" (
	"contact_hash" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cg_contributions_contact_hash_org_id_user_id_pk" PRIMARY KEY("contact_hash","org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "cg_intro_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"contact_hash" text NOT NULL,
	"requester_org_id" text NOT NULL,
	"requester_user_id" text NOT NULL,
	"target_org_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cg_org_participation" (
	"org_id" text PRIMARY KEY NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"opted_in_at" timestamp with time zone,
	"opted_in_by" text,
	"opted_out_at" timestamp with time zone,
	"opted_out_by" text
);
--> statement-breakpoint
CREATE TABLE "cg_verifications" (
	"contact_hash" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"mark_for_deletion" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cg_verifications_contact_hash_verified_at_pk" PRIMARY KEY("contact_hash","verified_at")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"contact_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"company_name" text,
	"job_title" text,
	"website" text,
	"status" text DEFAULT 'lead' NOT NULL,
	"lifecycle" text DEFAULT 'lead' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"converted_from_prospect_id" text,
	"owner_id" text NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposable_domains" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"domains" jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'github' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposable_singleton_check" CHECK ("disposable_domains"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "email_verification_cache" (
	"email_hash" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"mx_used" text,
	"source" text NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "find_leads_job_leads" (
	"job_id" text PRIMARY KEY NOT NULL,
	"partial_leads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "find_leads_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" integer DEFAULT 0 NOT NULL,
	"phase_label" text DEFAULT '' NOT NULL,
	"percent_complete" integer DEFAULT 0 NOT NULL,
	"searches_run" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"request" jsonb NOT NULL,
	"metadata" jsonb,
	"estimated_seconds" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"auth_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK (status in ('queued','running','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"batch_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"filename" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"progress" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_icp" (
	"org_id" text NOT NULL,
	"icp_key" text DEFAULT 'default' NOT NULL,
	"icp" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "org_icp_org_id_icp_key_pk" PRIMARY KEY("org_id","icp_key")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"prospect_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"title" text,
	"linkedin_url" text,
	"website" text,
	"avatar" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"enrichment" jsonb,
	"enrichment_sources" jsonb,
	"last_activity_date" timestamp with time zone,
	"contacted_at" timestamp with time zone,
	"converted_contact_id" text,
	"owner_id" text NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"import_batch_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_roles" (
	"company_slug" text NOT NULL,
	"title_slug" text NOT NULL,
	"name_slug" text NOT NULL,
	"name" text,
	"title" text,
	"company" text,
	"source" text,
	"source_url" text,
	"source_kind" text,
	"confidence" real,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '180 days' NOT NULL,
	CONSTRAINT "public_roles_company_slug_title_slug_name_slug_pk" PRIMARY KEY("company_slug","title_slug","name_slug")
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"enrollment_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"prospect_email" text NOT NULL,
	"prospect_name" text,
	"prospect_company" text,
	"enrolled_by" text,
	"status" text DEFAULT 'running' NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_advanced_at" timestamp with time zone,
	"exit_reason" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"sequence_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exit_on_reply" boolean DEFAULT true NOT NULL,
	"icp_filter" text,
	"status" text DEFAULT 'active' NOT NULL,
	"enrolled_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"exited_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweep_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sweep_type" text NOT NULL,
	"item_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL,
	CONSTRAINT "sweep_type_check" CHECK (sweep_type in ('funding','review','domain','social'))
);
--> statement-breakpoint
CREATE TABLE "tech_scans" (
	"domain" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"technologies" jsonb NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	CONSTRAINT "tech_scans_domain_scanned_at_pk" PRIMARY KEY("domain","scanned_at")
);
--> statement-breakpoint
CREATE TABLE "tool_rate_limits" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'member' NOT NULL,
	"cognito_sub" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cg_contributions" ADD CONSTRAINT "cg_contributions_contact_hash_cg_contacts_contact_hash_fk" FOREIGN KEY ("contact_hash") REFERENCES "public"."cg_contacts"("contact_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cg_verifications" ADD CONSTRAINT "cg_verifications_contact_hash_cg_contacts_contact_hash_fk" FOREIGN KEY ("contact_hash") REFERENCES "public"."cg_contacts"("contact_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_leads_job_leads" ADD CONSTRAINT "find_leads_job_leads_job_id_find_leads_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."find_leads_jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_import_batch_id_import_batches_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("batch_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_sequences_sequence_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("sequence_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cg_contacts_email_idx" ON "cg_contacts" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "cg_contrib_org_user_idx" ON "cg_contributions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "cg_intro_target_idx" ON "cg_intro_requests" USING btree ("target_org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cg_intro_target_user_idx" ON "cg_intro_requests" USING btree ("target_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cg_intro_contact_idx" ON "cg_intro_requests" USING btree ("contact_hash");--> statement-breakpoint
CREATE INDEX "cg_intro_requester_idx" ON "cg_intro_requests" USING btree ("contact_hash","requester_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_org_email_idx" ON "contacts" USING btree ("org_id",lower("email"));--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_verify_expires_idx" ON "email_verification_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "enrichment_cache_expires_idx" ON "enrichment_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "jobs_org_created_idx" ON "find_leads_jobs" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_expires_idx" ON "find_leads_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "jobs_inflight_idx" ON "find_leads_jobs" USING btree ("updated_at") WHERE status in ('queued','running');--> statement-breakpoint
CREATE INDEX "import_batches_org_idx" ON "import_batches" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prospects_org_created_idx" ON "prospects" USING btree ("org_id","created_at" DESC NULLS LAST,"prospect_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prospects_org_owner_idx" ON "prospects" USING btree ("org_id","owner_id","created_at" DESC NULLS LAST,"prospect_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prospects_org_status_score_idx" ON "prospects" USING btree ("org_id","status","score" DESC NULLS LAST,"prospect_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "prospects_org_email_idx" ON "prospects" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "prospects_org_company_name_idx" ON "prospects" USING btree ("org_id",lower("company"),lower("name"));--> statement-breakpoint
CREATE INDEX "prospects_tags_idx" ON "prospects" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "prospects_batch_idx" ON "prospects" USING btree ("import_batch_id") WHERE import_batch_id is not null;--> statement-breakpoint
CREATE INDEX "public_roles_expires_idx" ON "public_roles" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "enrollments_org_seq_idx" ON "sequence_enrollments" USING btree ("org_id","sequence_id");--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "sequence_enrollments" USING btree ("next_run_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "enrollments_active_email_idx" ON "sequence_enrollments" USING btree ("org_id",lower("prospect_email")) WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "sequences_org_idx" ON "sequences" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sweep_type_hash_idx" ON "sweep_items" USING btree ("sweep_type","item_hash");--> statement-breakpoint
CREATE INDEX "sweep_type_time_idx" ON "sweep_items" USING btree ("sweep_type","ingested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sweep_expires_idx" ON "sweep_items" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tech_scans_expires_idx" ON "tech_scans" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "tool_rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_cognito_sub_idx" ON "users" USING btree ("cognito_sub");