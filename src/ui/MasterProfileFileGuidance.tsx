import {
  MASTER_PROFILE_FILE_SOURCES,
  isMasterProfileSourceReviewDue,
  type MasterFileDeliveryVerdict,
  type MasterProfile,
} from "../mastering/profiles";

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

export function MasterProfileFileCheck({ verdict }: { verdict: MasterFileDeliveryVerdict | null }) {
  if (!verdict) return null;
  return (
    <div
      className="mastering-file-session-verdict"
      data-state={verdict.status}
      role="group"
      aria-label="Profile file delivery check"
    >
      <strong>VERIFIED FILE DELIVERY CHECK · {verdict.status.toUpperCase()}</strong>
      {verdict.checks.map((check, index) => (
        <small key={`${check.line}-${index}`} data-state={check.status}>
          {check.line}
        </small>
      ))}
    </div>
  );
}
