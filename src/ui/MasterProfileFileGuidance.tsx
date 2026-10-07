import { MASTER_PROFILE_FILE_SOURCES, isMasterProfileSourceReviewDue, type MasterProfile } from "../mastering/profiles";

export function MasterProfileFileGuidance({ profile }: { profile: MasterProfile }) {
  if (!profile.fileGuidanceNote) return null;
  const source = MASTER_PROFILE_FILE_SOURCES[profile.id];
  const reviewDue = source ? isMasterProfileSourceReviewDue(source) : false;

  return (
    <small className="mastering-profile-file-guidance" data-review-due={reviewDue}>
      {profile.fileGuidanceNote}
      {source && (
        <>
          {" "}
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>{" "}
          · checked {source.checkedAt}.{reviewDue && " Source review is due before relying on this guidance."}
        </>
      )}
    </small>
  );
}
