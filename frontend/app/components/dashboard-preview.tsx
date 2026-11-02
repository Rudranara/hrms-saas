import { Icon, type IconName } from "./ui-icon";
const modules: [IconName, string][] = [
  ["grid", "Overview"],
  ["people", "Employees"],
  ["clock", "Attendance"],
  ["calendar", "Time off"],
  ["wallet", "Payroll"],
  ["chart", "Reports"],
];
export function DashboardPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`dashboard ${compact ? "dashboard-compact" : ""}`}
      role="img"
      aria-label="Illustrative HR dashboard: 248 employees, 232 present today, 8 pending leave requests, attendance chart and recent sample activity."
    >
      <div className="dash-browser">
        <span />
        <span />
        <span />
        <div>Workspace overview</div>
        <span className="dash-demo">SAMPLE DATA</span>
      </div>
      <div className="dash-layout">
        <aside className="dash-sidebar">
          <div className="dash-brand">
            <span className="brand-mark">
              <Icon name="organization" />
            </span>
            HRMS
          </div>
          <div className="workspace">
            <span className="workspace-avatar">W</span>
            <div>
              Workspace<small>Organization</small>
            </div>
            <Icon name="chevron" />
          </div>
          <small className="sidebar-label">WORKSPACE</small>
          {modules.map(([icon, label], i) => (
            <div
              className={`sidebar-item ${i === 0 ? "selected" : ""}`}
              key={label}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {label === "Time off" && <b>8</b>}
            </div>
          ))}
          <div className="sidebar-bottom">
            <span className="avatar">JD</span>
            <div>
              Jordan Davis<small>HR Administrator</small>
            </div>
          </div>
        </aside>
        <div className="dash-main">
          <div className="dash-toolbar">
            <span>
              Workspace <span>/</span> <b>Overview</b>
            </span>
            <div>
              <Icon name="search" />
              <Icon name="bell" />
              <span className="avatar">JD</span>
            </div>
          </div>
          <div className="dash-content">
            <div className="dash-greeting">
              <div>
                <h3>
                  Your people, at a glance <span>☀</span>
                </h3>
                <p>Here’s what’s happening across your organization.</p>
              </div>
              <span className="date-chip">
                <Icon name="calendar" /> Oct 26, 2026
              </span>
            </div>
            <div className="dash-stats">
              {[
                ["people", "Total employees", "248", "+12 this month"],
                ["clock", "Present today", "232", "93.5% attendance"],
                ["calendar", "Pending leave", "08", "Awaiting review"],
              ].map(([icon, label, value, note], i) => (
                <div className="stat" key={label}>
                  <div>
                    <span>{label}</span>
                    <Icon name={icon as IconName} />
                  </div>
                  <strong>{value}</strong>
                  <small className={i === 2 ? "amber" : "green"}>
                    {i < 2 && "↗ "}
                    {note}
                  </small>
                </div>
              ))}
            </div>
            <div className="dash-panels">
              <div className="attendance-panel">
                <div className="panel-title">
                  <h4>Attendance overview</h4>
                  <span>
                    This week <Icon name="chevron" />
                  </span>
                </div>
                <div className="chart-legend">
                  <span /> Present <span /> Absent
                </div>
                <div className="chart">
                  <div className="chart-axis">
                    <span>100%</span>
                    <span>75%</span>
                    <span>50%</span>
                    <span>25%</span>
                  </div>
                  {[85, 94, 88, 96, 91].map((height, i) => (
                    <div className="chart-column" key={i}>
                      <div className="bar-track">
                        <div
                          className="chart-bar"
                          style={{ height: `${height}%` }}
                        />
                        <div
                          className="chart-bar pale"
                          style={{ height: `${100 - height}%` }}
                        />
                      </div>
                      <span>{["Mon", "Tue", "Wed", "Thu", "Fri"][i]}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="activity-panel">
                <div className="panel-title">
                  <h4>Recent activity</h4>
                  <span>•••</span>
                </div>
                {[
                  [
                    "AS",
                    "Alex Smith",
                    "submitted a leave request",
                    "10 min ago",
                  ],
                  ["MC", "Maya Chen", "joined the Design team", "32 min ago"],
                  ["JP", "Jamie Park", "updated their profile", "1 hour ago"],
                ].map(([initials, name, action, time], i) => (
                  <div className="activity" key={initials}>
                    <span className={`avatar avatar-${i}`}>{initials}</span>
                    <div>
                      <strong>{name}</strong>
                      <p>{action}</p>
                      <small>{time}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="leave-panel">
              <div className="panel-title">
                <h4>Leave requests</h4>
                <span>8 pending</span>
              </div>
              <div className="leave-request">
                <span className="avatar avatar-0">AS</span>
                <div>
                  <strong>Alex Smith</strong>
                  <p>Annual leave · Oct 28–29</p>
                </div>
                <span className="leave-duration">2 days</span>
                <span className="pending-badge">Pending review</span>
              </div>
            </div>
            <div className="payroll-summary">
              <span className="payroll-icon">
                <Icon name="wallet" />
              </span>
              <div>
                <strong>Everything in its place.</strong>
                <p>People, time, and payroll. One connected workspace.</p>
              </div>
              <span className="status-label">
                <span className="little-dot" /> Sample workspace
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
