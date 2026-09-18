import { Link } from "react-router-dom";

function Profile() {
  return (
    <div className="page-content empty-page"><p className="eyebrow">Workspace settings</p><h1>Accounts<span>.</span></h1><p className="heading-copy">Manage your connected accounts and personal details here.</p><Link className="primary-button" to="/dashboard">Back to overview <span>→</span></Link>
    </div>
  );
}
export default Profile;