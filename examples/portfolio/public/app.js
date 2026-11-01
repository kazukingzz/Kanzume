// いいね：押した作品は localStorage に覚えておき、同じブラウザからは 1 回だけ数える
const LIKED_KEY = "portfolio:liked";

function readLiked() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveLiked(set) {
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify([...set]));
  } catch {
    // プライベートモードなどで保存できなくても、いいね自体は送る
  }
}

const liked = readLiked();

async function setupLikes() {
  const works = document.querySelectorAll(".work[data-slug]");
  let counts = {};
  try {
    counts = await (await fetch("/api/likes")).json();
  } catch {
    // Worker なしで開いたとき（ファイルを直接開くなど）は数を出さない
  }
  for (const work of works) {
    const slug = work.dataset.slug;
    const button = work.querySelector(".like");
    const count = button.querySelector(".count");
    count.textContent = slug in counts ? counts[slug] : "–";
    button.setAttribute("aria-pressed", String(liked.has(slug)));
    let sending = false;
    button.addEventListener("click", async () => {
      if (liked.has(slug) || sending) return;
      sending = true;
      button.setAttribute("aria-pressed", "true");
      button.classList.add("pop");
      setTimeout(() => button.classList.remove("pop"), 200);
      try {
        const res = await fetch(`/api/likes/${slug}`, { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        count.textContent = (await res.json()).count;
        // 送れたときだけ覚える（失敗したらもう一度押せるようにする）
        liked.add(slug);
        saveLiked(liked);
      } catch {
        button.setAttribute("aria-pressed", "false");
      } finally {
        sending = false;
      }
    });
  }
}

function setupContact() {
  const form = document.getElementById("contact-form");
  const status = document.getElementById("form-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button[type=submit]");
    status.className = "form-status";
    if (!form.checkValidity()) {
      status.textContent = "未入力の項目があります";
      status.classList.add("bad");
      form.reportValidity();
      return;
    }
    button.disabled = true;
    status.textContent = "送信中…";
    try {
      const res = await fetch("/api/contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `送信できませんでした（HTTP ${res.status}）`);
      form.reset();
      status.textContent = "送信しました。ありがとうございます！";
      status.classList.add("ok");
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("bad");
    } finally {
      button.disabled = false;
    }
  });
}

setupLikes();
setupContact();
