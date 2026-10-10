class KinResponsibility extends HTMLElement {
  set record(value) { this.value = value; this.render(); }
  render() {
    if (!this.value) return;
    const { targetKind, targetId, text, ownerId, memberId, memberIds = [] } = this.value;
    const status = document.createElement("span");
    status.className = "responsibility-status";
    const ownerIndex = memberIds.indexOf(ownerId);
    status.textContent = !ownerId
      ? "Unassigned"
      : ownerId === memberId
        ? "You"
        : ownerIndex >= 0
          ? `Household adult ${ownerIndex + 1}`
          : "Former household adult";
    this.replaceChildren(status);
    const action = (label, assignedMemberId) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label; button.setAttribute("aria-label", label);
      button.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:change-responsibility", { detail: { targetKind, targetId, memberId: assignedMemberId }, bubbles: true, composed: true })));
      this.append(button);
    };
    if (ownerId !== memberId) action(`Take responsibility for ${text}`, memberId);
    for (const id of memberIds.filter((id) => id !== memberId)) {
      const adultNumber = memberIds.indexOf(id) + 1;
      if (ownerId !== id) action(`Assign ${text} to household adult ${adultNumber}`, id);
    }
    if (ownerId) action(`Clear responsibility for ${text}`, null);
  }
}
customElements.define("kin-responsibility", KinResponsibility);
