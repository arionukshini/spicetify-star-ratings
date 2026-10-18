import "./sort-modal.css";

const React = Spicetify.React;

interface ButtonProps {
    name: string;
    className: string;
    onButtonClick: () => void;
}

interface SortModalProps {
    onClickCancel: () => void;
    onClickOK: () => void;
}

export function Button({ name, className, onButtonClick }: ButtonProps) {
    return (
        <button className={className} onClick={onButtonClick}>
            {name}
        </button>
    );
}

export function SortModal({ onClickCancel, onClickOK }: SortModalProps) {
    return (
        <div className="parent-div">
            <p>
                This will modify the <b>Custom order</b> of the playlist.
            </p>
            <div className="button-div">
                <Button name="Cancel" className="cancel-button" onButtonClick={onClickCancel} />
                <Button name="Sort" className="ok-button" onButtonClick={onClickOK} />
            </div>
        </div>
    );
}
