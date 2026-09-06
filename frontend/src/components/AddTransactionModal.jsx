import { useState } from "react";

function AddTransaction({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Food & Dining");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("expense");

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!name || !amount) return;

    onAdd({
      id: Date.now(),
      name,
      category,
      amount: Number(amount),
      type,
    });

    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="transaction-modal">
        <div className="modal-header">
          <div>
            <span className="eyebrow">FINANCIAL ACTIVITY</span>
            <h2>Add transaction</h2>
          </div>

          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label>
            Transaction name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Grocery shopping"
            />
          </label>

          <label>
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option>Food & Dining</option>
              <option>Entertainment</option>
              <option>Transport</option>
              <option>Shopping</option>
              <option>Bills</option>
              <option>Income</option>
              <option>Other</option>
            </select>
          </label>

          <label>
            Amount
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </label>

          <label>
            Type
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>

          <div className="modal-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
            >
              Cancel
            </button>

            <button type="submit" className="save-button">
              Add transaction →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddTransaction;