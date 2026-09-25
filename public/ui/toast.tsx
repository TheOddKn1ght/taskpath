export function Toast({text,undo,close}:{text:string;undo?:()=>void;close:()=>void}) { return (
    <div id="toast" className="toast fixed flex gap-4 items-center bg-toast text-on-toast rounded-md py-[11px] pr-[13px] pl-[17px] text-[12px] max-w-[calc(100vw-24px)] z-10" role="status">
      <span id="toast-message">{text}</span>
      {undo && (
        <button
          id="toast-action"
          className="text-on-toast text-[12px] p-[3px] underline underline-offset-[3px]"
          onClick={undo}
        >
          Undo
        </button>
      )}
      <button
        id="toast-close"
        className="icon-button text-on-toast! text-[12px] p-[3px]!"
        aria-label="Dismiss notification"
        onClick={close}
      >
        ×
      </button>
    </div>

  );
}
