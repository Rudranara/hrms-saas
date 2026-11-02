import { Icon, type IconName } from "./ui-icon";

/** Static product concepts. These records never come from the health-check API. */
export function FeaturePreview({ kind }: { kind: IconName }) {
  if (kind === "organization" || kind === "chart") return null;
  return (
    <div className={`feature-preview preview-${kind}`}>
      <div className="mini-heading">
        <strong>
          {
            (
              {
                people: "Your people",
                clock: "This week",
                calendar: "Time off",
                wallet: "Payroll overview",
              } as Partial<Record<IconName, string>>
            )[kind]
          }
        </strong>
        <span>Sample data</span>
      </div>
      {kind === "people" && (
        <div className="mini-employees">
          {[
            ["MC", "Maya Chen", "Product Design"],
            ["JP", "Jamie Park", "Engineering"],
            ["AS", "Alex Smith", "Operations"],
          ].map(([initials, name, team], index) => (
            <div key={initials}>
              <span className={`avatar avatar-${index}`}>{initials}</span>
              <div>
                <strong>{name}</strong>
                <small>{team}</small>
              </div>
              <span className="mini-active">Active</span>
            </div>
          ))}
        </div>
      )}
      {kind === "clock" && (
        <>
          <div className="mini-metric">
            <strong>
              93.5<span>%</span>
            </strong>
            <span>Attendance</span>
          </div>
          <div
            className="mini-bars"
            role="img"
            aria-label="Sample weekday attendance between 85 and 96 percent"
          >
            {[85, 94, 88, 96, 91].map((value, i) => (
              <div key={i}>
                <span style={{ height: `${value}%` }} />
                <small>{["M", "T", "W", "T", "F"][i]}</small>
              </div>
            ))}
          </div>
        </>
      )}
      {kind === "calendar" && (
        <>
          <div className="mini-leave">
            <span className="feature-icon">
              <Icon name="calendar" />
            </span>
            <div>
              <strong>Annual leave</strong>
              <small>Alex Smith · Oct 28–29</small>
            </div>
          </div>
          <div className="mini-approval">
            <span className="pending-badge">Pending review</span>
            <span>2 days</span>
          </div>
        </>
      )}
      {kind === "wallet" && (
        <>
          <div className="mini-payroll">
            <span className="feature-icon">
              <Icon name="wallet" />
            </span>
            <div>
              <strong>October payroll</strong>
              <small>One organized monthly overview</small>
            </div>
          </div>
          <div className="mini-payroll-row">
            <span>Pay period</span>
            <strong>Oct 1–31</strong>
          </div>
          <div className="mini-payroll-row">
            <span>Records prepared</span>
            <strong>248 employees</strong>
          </div>
          <div className="mini-payroll-row">
            <span>Status</span>
            <span className="pending-badge">Draft · sample</span>
          </div>
        </>
      )}
    </div>
  );
}
