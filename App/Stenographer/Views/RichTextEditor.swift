import AppKit
import Observation
import SwiftUI

/// Formatting state and actions for the notes editor's `NSTextView`.
@MainActor @Observable
final class RichTextController: NSObject, NSTextViewDelegate {
    static let sizes: [CGFloat] = [9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 48]
    static let families = NSFontManager.shared.availableFontFamilies
    static let defaultFont = NSFont.systemFont(ofSize: NSFont.systemFontSize + 1)

    @ObservationIgnored fileprivate weak var textView: NSTextView?
    @ObservationIgnored private var pending: NSAttributedString?
    @ObservationIgnored var onChange: (() -> Void)?

    private(set) var isEmpty = true
    private(set) var isBold = false
    private(set) var isItalic = false
    private(set) var isUnderlined = false
    private(set) var isStruckThrough = false
    private(set) var family = ""
    private(set) var size = defaultFont.pointSize
    private(set) var color = Color(nsColor: .labelColor)
    private(set) var alignment = NSTextAlignment.left

    // MARK: Content

    fileprivate func attach(_ view: NSTextView) {
        textView = view
        view.delegate = self
        view.typingAttributes = Self.baseAttributes
        if let pending {
            view.textStorage?.setAttributedString(pending)
            self.pending = nil
        }
        refresh()
    }

    /// Replaces the document. Does not call `onChange`.
    func setContent(plain: String, rtf: Data?) {
        let content = Self.attributedString(plain: plain, rtf: rtf)
        if let textView {
            textView.textStorage?.setAttributedString(content)
            textView.typingAttributes = Self.baseAttributes
            textView.undoManager?.removeAllActions()
            refresh()
        } else {
            pending = content
        }
    }

    /// Plain text for search and prompts, and RTF with the formatting.
    func snapshot() -> (plain: String, rtf: Data?) {
        guard let storage = textView?.textStorage else { return ("", nil) }
        let plain = storage.string
        let copy = NSMutableAttributedString(attributedString: storage)
        let whole = NSRange(location: 0, length: copy.length)
        // The default text color is dynamic; saving it as fixed RGB would be unreadable in the other appearance.
        copy.enumerateAttribute(.foregroundColor, in: whole) { value, range, _ in
            if let c = value as? NSColor, c == .labelColor || c == .textColor { copy.removeAttribute(.foregroundColor, range: range) }
        }
        let rtf = try? copy.data(from: whole, documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        return (plain, rtf)
    }

    private static var baseAttributes: [NSAttributedString.Key: Any] {
        [.font: defaultFont, .foregroundColor: NSColor.labelColor]
    }

    private static func attributedString(plain: String, rtf: Data?) -> NSAttributedString {
        let result: NSMutableAttributedString
        if let rtf, let rich = try? NSAttributedString(data: rtf, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
            result = NSMutableAttributedString(attributedString: rich)
        } else {
            result = NSMutableAttributedString(string: plain, attributes: baseAttributes)
        }
        let whole = NSRange(location: 0, length: result.length)
        result.enumerateAttribute(.foregroundColor, in: whole) { value, range, _ in
            if value == nil { result.addAttribute(.foregroundColor, value: NSColor.labelColor, range: range) }
        }
        return result
    }

    // MARK: Delegate

    func textDidChange(_ notification: Notification) {
        refresh()
        onChange?()
    }

    func textViewDidChangeSelection(_ notification: Notification) { refresh() }

    // MARK: State

    private func currentAttributes() -> [NSAttributedString.Key: Any] {
        guard let view = textView else { return Self.baseAttributes }
        let range = view.selectedRange()
        if range.length == 0 { return view.typingAttributes }
        guard let storage = view.textStorage, range.location < storage.length else { return view.typingAttributes }
        return storage.attributes(at: range.location, effectiveRange: nil)
    }

    private func refresh() {
        let attributes = currentAttributes()
        let font = (attributes[.font] as? NSFont) ?? Self.defaultFont
        let traits = NSFontManager.shared.traits(of: font)
        isEmpty = (textView?.string.isEmpty ?? true)
        isBold = traits.contains(.boldFontMask)
        isItalic = traits.contains(.italicFontMask)
        isUnderlined = ((attributes[.underlineStyle] as? Int) ?? 0) != 0
        isStruckThrough = ((attributes[.strikethroughStyle] as? Int) ?? 0) != 0
        family = font.familyName ?? ""
        size = font.pointSize
        color = Color(nsColor: (attributes[.foregroundColor] as? NSColor) ?? .labelColor)
        let style = attributes[.paragraphStyle] as? NSParagraphStyle
        alignment = style?.alignment ?? .left
    }

    // MARK: Actions

    func toggleBold() { toggleTrait(.boldFontMask, on: isBold) }
    func toggleItalic() { toggleTrait(.italicFontMask, on: isItalic) }
    func setFamily(_ name: String) { changeFonts { NSFontManager.shared.convert($0, toFamily: name) } }
    func setSize(_ points: CGFloat) { changeFonts { NSFontManager.shared.convert($0, toSize: points) } }
    func toggleUnderline() { toggleLine(.underlineStyle, on: isUnderlined) }
    func toggleStrikethrough() { toggleLine(.strikethroughStyle, on: isStruckThrough) }
    func setColor(_ color: Color) { setAttribute(.foregroundColor, NSColor(color)) }

    func setAlignment(_ alignment: NSTextAlignment) {
        guard let view = textView else { return }
        view.alignment = alignment
        refresh()
        onChange?()
    }

    /// Removes character formatting from the selection (or the next typed text).
    func clearFormatting() {
        guard let view = textView, let storage = view.textStorage else { return }
        let range = view.selectedRange()
        if range.length == 0 {
            view.typingAttributes = Self.baseAttributes
        } else if view.shouldChangeText(in: range, replacementString: nil) {
            storage.beginEditing()
            storage.setAttributes(Self.baseAttributes, range: range)
            storage.endEditing()
            view.didChangeText()
        }
        refresh()
    }

    private func toggleTrait(_ trait: NSFontTraitMask, on: Bool) {
        changeFonts { on ? NSFontManager.shared.convert($0, toNotHaveTrait: trait) : NSFontManager.shared.convert($0, toHaveTrait: trait) }
    }

    private func toggleLine(_ key: NSAttributedString.Key, on: Bool) {
        setAttribute(key, on ? 0 : NSUnderlineStyle.single.rawValue)
    }

    private func setAttribute(_ key: NSAttributedString.Key, _ value: Any) {
        guard let view = textView, let storage = view.textStorage else { return }
        let range = view.selectedRange()
        if range.length == 0 {
            view.typingAttributes[key] = value
        } else if view.shouldChangeText(in: range, replacementString: nil) {
            storage.beginEditing()
            storage.addAttribute(key, value: value, range: range)
            storage.endEditing()
            view.didChangeText()
        }
        view.window?.makeFirstResponder(view)
        refresh()
    }

    private func changeFonts(_ transform: (NSFont) -> NSFont) {
        guard let view = textView, let storage = view.textStorage else { return }
        let range = view.selectedRange()
        if range.length == 0 {
            let font = (view.typingAttributes[.font] as? NSFont) ?? Self.defaultFont
            view.typingAttributes[.font] = transform(font)
        } else if view.shouldChangeText(in: range, replacementString: nil) {
            storage.beginEditing()
            storage.enumerateAttribute(.font, in: range) { value, sub, _ in
                storage.addAttribute(.font, value: transform((value as? NSFont) ?? Self.defaultFont), range: sub)
            }
            storage.endEditing()
            view.didChangeText()
        }
        view.window?.makeFirstResponder(view)
        refresh()
    }
}

struct RichTextEditor: NSViewRepresentable {
    let controller: RichTextController

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.isRichText = true
        view.importsGraphics = false
        view.allowsUndo = true
        view.usesFontPanel = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.drawsBackground = false
        view.textContainerInset = NSSize(width: 6, height: 8)
        controller.attach(view)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {}
}

/// Formatting bar for `RichTextEditor`.
struct RichTextToolbar: View {
    let controller: RichTextController

    var body: some View {
        HStack(spacing: 10) {
            Picker("Font", selection: Binding(get: { controller.family }, set: { controller.setFamily($0) })) {
                if !RichTextController.families.contains(controller.family) { Text("System").tag(controller.family) }
                ForEach(RichTextController.families, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .frame(width: 150)
            .help("Font")
            Picker("Size", selection: Binding(get: { controller.size }, set: { controller.setSize($0) })) {
                if !RichTextController.sizes.contains(controller.size) { Text("\(Int(controller.size.rounded()))").tag(controller.size) }
                ForEach(RichTextController.sizes, id: \.self) { Text("\(Int($0))").tag($0) }
            }
            .labelsHidden()
            .frame(width: 64)
            .help("Font size")
            Divider().frame(height: 16)
            toggle("bold", "Bold", "b", controller.isBold, controller.toggleBold)
            toggle("italic", "Italic", "i", controller.isItalic, controller.toggleItalic)
            toggle("underline", "Underline", "u", controller.isUnderlined, controller.toggleUnderline)
            toggle("strikethrough", "Strikethrough", nil, controller.isStruckThrough, controller.toggleStrikethrough)
            ColorPicker("Text color", selection: Binding(get: { controller.color }, set: { controller.setColor($0) }), supportsOpacity: false)
                .labelsHidden()
                .help("Text color")
            Divider().frame(height: 16)
            toggle("text.alignleft", "Align left", nil, controller.alignment == .left || controller.alignment == .natural) { controller.setAlignment(.left) }
            toggle("text.aligncenter", "Align center", nil, controller.alignment == .center) { controller.setAlignment(.center) }
            toggle("text.alignright", "Align right", nil, controller.alignment == .right) { controller.setAlignment(.right) }
            Divider().frame(height: 16)
            Button { controller.clearFormatting() } label: { Image(systemName: "eraser") }
                .help("Clear formatting")
            Spacer()
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func toggle(_ symbol: String, _ help: String, _ key: Character?, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        let button = Button(action: action) {
            Image(systemName: symbol)
                .frame(width: 24, height: 22)
                .background(on ? Color.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 5))
        }
        .help(help)
        if let key { button.keyboardShortcut(KeyEquivalent(key), modifiers: .command) } else { button }
    }
}
