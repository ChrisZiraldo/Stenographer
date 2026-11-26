import SwiftUI

/// "Choose from People" dropdown used next to name fields; picking a name fills the field.
struct PeoplePickerMenu: View {
    let names: [String]
    let pick: (String) -> Void

    var body: some View {
        Menu {
            ForEach(names, id: \.self) { name in
                Button(name) { pick(name) }
            }
        } label: {
            Label("People", systemImage: "person.2")
        }
        .fixedSize()
        .disabled(names.isEmpty)
        .help(names.isEmpty ? "No saved people yet" : "Choose someone from your People list")
    }
}
