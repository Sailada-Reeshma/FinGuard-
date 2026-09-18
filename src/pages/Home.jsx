import { Link } from "react-router-dom";

function Home() {
  return (
    <div className="page-content empty-page">
      <p className="eyebrow">FinGuard workspace</p><h1>Money, with a clearer view<span>.</span></h1><p className="heading-copy">Your smart and secure personal finance companion.</p><Link className="primary-button" to="/dashboard">Open dashboard <span>→</span></Link>
    </div>
  );
}

export default Home;