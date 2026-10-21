/** Launch only: this mutable page cannot grant approval or receive human credentials. */
export function SlackApprovalsButton({ approvalURL }: { approvalURL: string }) {
  let url: string;
  try {
    const target = new URL(approvalURL);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.pathname !== '/review' ||
      target.search ||
      target.hash
    )
      return null;
    url = target.href;
  } catch {
    return null;
  }
  // Native user-initiated navigation avoids script-popup success detection:
  // noopener's null return cannot distinguish a blocked popup from success.
  // The browser also supplies open/copy-link actions without fallback clutter.
  return (
    <a className="slack-approval-review" href={url} target="_blank" rel="noopener noreferrer">
      Review
    </a>
  );
}
